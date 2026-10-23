using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Npgsql;
using Yadbc.Contracts.Broker;
using Yadbc.Host.Connections;
using Yadbc.Host.Sharing;

namespace Yadbc.Host.Ai;

/// <summary>
/// The assistant: settings, the endpoint's model list, and chat — proxied through the backend so the API
/// key stays out of the page, streamed back as server-sent events (content and reasoning separately).
/// </summary>
public static class AiEndpoints
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public sealed record SettingsInput(string? Endpoint, string? Model, int? MaxTokens, string? Key);

    public sealed record ShareAiInput(bool IncludeKey);

    public sealed record ChatMessage(string Role, string Content);

    public sealed record ChatContext(string? Sql, string? Error, string? Plan);

    public sealed record ChatInput(string ConnectionId, List<ChatMessage> Messages, ChatContext? Context);

    public static void MapAiEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/ai");

        // What's in use (endpoint, model…: what the panel shows), and the two sources behind it.
        api.MapGet("/settings", (AiSettings settings, TeamAiSettings team, Broker broker) =>
        {
            var own = settings.Load();
            var t = team.Current;
            var useOwn = !string.IsNullOrWhiteSpace(own.Endpoint);
            var ownKey = settings.Key is not null;
            return Results.Ok(new
            {
                endpoint = useOwn ? own.Endpoint : t?.Endpoint,
                model = useOwn ? own.Model : t?.Model,
                maxTokens = useOwn || t is null ? own.MaxTokens : t.MaxTokens,
                hasKey = ownKey || (!useOwn && t is { HasKey: true }),
                source = useOwn ? "own" : t is null ? "none" : "team",
                own = new { own.Endpoint, own.Model, own.MaxTokens, hasKey = ownKey },
                team = t is null ? null : new { t.Endpoint, t.Model, t.MaxTokens, t.HasKey, updatedBy = t.UpdatedBy.Name, t.UpdatedAt },
                canShare = broker.IsAdmin,
            });
        });

        // Admins: your own settings become the team's (with the key, or for everyone to bring their own).
        api.MapPost("/share", async (ShareAiInput input, AiSettings settings, TeamAiSettings team, Broker broker, CancellationToken ct) =>
        {
            var own = settings.Load();
            if (string.IsNullOrWhiteSpace(own.Endpoint) || string.IsNullOrWhiteSpace(own.Model))
                return Results.BadRequest(new { error = "Save your own endpoint and model first; those are what gets shared." });
            try
            {
                await broker.ShareTeamAiAsync(new TeamAiInput(own.Endpoint, own.Model, own.MaxTokens, input.IncludeKey ? settings.Key : null), ct);
                await team.RefreshAsync(ct);
                return Results.NoContent();
            }
            catch (BrokerException e)
            {
                return Results.BadRequest(new { error = e.Message });
            }
        });

        api.MapDelete("/share", async (TeamAiSettings team, Broker broker, CancellationToken ct) =>
        {
            try
            {
                await broker.StopTeamAiAsync(ct);
                await team.RefreshAsync(ct);
                return Results.NoContent();
            }
            catch (BrokerException e)
            {
                return Results.BadRequest(new { error = e.Message });
            }
        });

        api.MapPut("/settings", (SettingsInput input, AiSettings settings) =>
        {
            var c = settings.Load();
            settings.Save(c with
            {
                Endpoint = string.IsNullOrWhiteSpace(input.Endpoint) ? null : input.Endpoint.Trim(),
                Model = string.IsNullOrWhiteSpace(input.Model) ? null : input.Model.Trim(),
                MaxTokens = input.MaxTokens is > 0 and <= 65536 ? input.MaxTokens.Value : c.MaxTokens,
            });
            settings.SetKey(input.Key);
            return Results.NoContent();
        });

        // The endpoint's models — also how "Test" checks the URL and key.
        api.MapPost("/models", async (SettingsInput input, AiSettings settings, TeamAiSettings team, IHttpClientFactory http, CancellationToken ct) =>
        {
            var effective = await settings.EffectiveAsync(team, ct);
            var endpoint = string.IsNullOrWhiteSpace(input.Endpoint) ? effective.Endpoint : input.Endpoint;
            if (string.IsNullOrWhiteSpace(endpoint)) return Results.BadRequest(new { error = "No endpoint set." });
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, AiSettings.BaseUrl(endpoint) + "/models");
                Authorize(req, string.IsNullOrEmpty(input.Key) ? effective.Key : input.Key);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(15));
                using var res = await http.CreateClient("llm").SendAsync(req, timeout.Token);
                var body = await res.Content.ReadAsStringAsync(timeout.Token);
                if (!res.IsSuccessStatusCode) return Results.BadRequest(new { error = $"{(int)res.StatusCode} {res.ReasonPhrase}: {Short(body)}" });
                var ids = JsonNode.Parse(body)?["data"]?.AsArray().Select(m => m?["id"]?.GetValue<string>()).Where(i => i is not null).Order().ToList();
                return Results.Ok(new { models = ids ?? [] });
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException)
            {
                return Results.BadRequest(new { error = ex is TaskCanceledException ? "No answer within 15 s." : ex.Message });
            }
        });

        api.MapPost("/chat", async (ChatInput input, HttpContext ctx, AiSettings settings, TeamAiSettings team, DataSourceCache sources,
            IHttpClientFactory http, CancellationToken ct) =>
        {
            var config = await settings.EffectiveAsync(team, ct);
            var res = ctx.Response;
            res.Headers.ContentType = "text/event-stream";
            res.Headers.CacheControl = "no-cache";
            async Task Send(object e)
            {
                await res.WriteAsync($"data: {JsonSerializer.Serialize(e, Json)}\n\n", ct);
                await res.Body.FlushAsync(ct);
            }

            if (string.IsNullOrWhiteSpace(config.Endpoint) || string.IsNullOrWhiteSpace(config.Model))
            {
                await Send(new { t = "e", v = "Set up the AI endpoint and model first." });
                return;
            }

            string system;
            try
            {
                system = await SystemPromptAsync(sources, input, ct);
            }
            catch (Exception ex) when (ex is NpgsqlException or TimeoutException or ConnectException or KeyNotFoundException)
            {
                // Still useful without the schema (explaining an error, a plan).
                system = BasePrompt(null) + $"\n(The schema couldn't be read: {ex.Message})";
            }

            var messages = new JsonArray { new JsonObject { ["role"] = "system", ["content"] = system } };
            foreach (var m in input.Messages.TakeLast(20))
                if (m.Role is "user" or "assistant")
                    messages.Add(new JsonObject { ["role"] = m.Role, ["content"] = m.Content });
            var payload = new JsonObject
            {
                ["model"] = config.Model,
                ["stream"] = true,
                ["max_tokens"] = config.MaxTokens,
                ["temperature"] = 0.2,
                ["messages"] = messages,
            };

            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, AiSettings.BaseUrl(config.Endpoint) + "/chat/completions")
                {
                    Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json"),
                };
                Authorize(req, config.Key);
                using var upstream = await http.CreateClient("llm").SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
                if (!upstream.IsSuccessStatusCode)
                {
                    await Send(new { t = "e", v = $"{(int)upstream.StatusCode} {upstream.ReasonPhrase}: {Short(await upstream.Content.ReadAsStringAsync(ct))}" });
                    return;
                }
                using var reader = new StreamReader(await upstream.Content.ReadAsStreamAsync(ct));
                while (await reader.ReadLineAsync(ct) is { } line)
                {
                    if (!line.StartsWith("data:")) continue;
                    var data = line[5..].Trim();
                    if (data == "[DONE]") break;
                    JsonNode? chunk;
                    try
                    {
                        chunk = JsonNode.Parse(data);
                    }
                    catch (JsonException)
                    {
                        continue;
                    }
                    var delta = chunk?["choices"]?[0]?["delta"];
                    // vLLM / LiteLLM put a reasoning model's thinking in reasoning_content (some proxies: reasoning).
                    if ((delta?["reasoning_content"] ?? delta?["reasoning"])?.GetValue<string>() is { Length: > 0 } thinking)
                        await Send(new { t = "r", v = thinking });
                    if (delta?["content"]?.GetValue<string>() is { Length: > 0 } text)
                        await Send(new { t = "c", v = text });
                }
                await Send(new { t = "d" });
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException)
            {
                if (!ct.IsCancellationRequested) await Send(new { t = "e", v = ex.Message });
            }
            catch (OperationCanceledException)
            {
                // the user pressed Stop / closed the panel
            }
        });
    }

    static async Task<string> SystemPromptAsync(DataSourceCache sources, ChatInput input, CancellationToken ct)
    {
        await using var conn = await sources.OpenCatalogAsync(input.ConnectionId, ct);
        // The whole conversation: a follow-up ("now group it by host") still means the tables asked about before.
        var mentions = (input.Context?.Sql ?? "") + "\n" + string.Join("\n", input.Messages.Where(m => m.Role == "user").Select(m => m.Content));
        var schema = await AiContext.SchemaAsync(conn, mentions, ct);
        var sb = new StringBuilder(BasePrompt(conn.PostgreSqlVersion.ToString()));
        sb.AppendLine().AppendLine().AppendLine(schema);
        if (input.Context?.Sql is { Length: > 0 } sql) sb.AppendLine().AppendLine("The statement in the editor:").AppendLine("```sql").AppendLine(Clip(sql, 8000)).AppendLine("```");
        if (input.Context?.Error is { Length: > 0 } error) sb.AppendLine().AppendLine("Its last run failed with:").AppendLine(Clip(error, 2000));
        if (input.Context?.Plan is { Length: > 0 } plan) sb.AppendLine().AppendLine("Its execution plan (EXPLAIN):").AppendLine(Clip(plan, 8000));
        return sb.ToString();
    }

    static string BasePrompt(string? version) =>
        $"""
        You are the assistant inside yadbc, a PostgreSQL client{(version is null ? "" : $" connected to PostgreSQL {version}")}.
        Answer briefly and concretely, for an experienced developer. Use the schema below — don't invent tables or columns;
        if something needed isn't there, say so. When you give SQL, give one complete PostgreSQL statement per ```sql block.
        Point out when a statement changes or deletes data. Never ask for or reveal passwords or keys.
        """;

    static void Authorize(HttpRequestMessage req, string? key)
    {
        if (!string.IsNullOrEmpty(key)) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
    }

    static string Clip(string s, int max) => s.Length > max ? s[..max] + "\n…(cut)" : s;

    static string Short(string s) => s.Length > 300 ? s[..300] + "…" : s;
}

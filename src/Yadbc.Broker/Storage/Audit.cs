namespace Yadbc.Broker.Storage;

/// <summary>Who did what to which share, and every login handed out. Never pruned: it's small.</summary>
public static class Audit
{
    public const string SignedIn = "signed-in";
    public const string ShareCreated = "share-created";
    public const string ShareUpdated = "share-updated";
    public const string ShareDeleted = "share-deleted";
    public const string LoginSet = "login-set";
    public const string LoginFetched = "login-fetched";
    public const string TeamAiShared = "team-ai-shared";
    public const string TeamAiRemoved = "team-ai-removed";
    public const string TeamAiKeyFetched = "team-ai-key-fetched";
    public const string SnippetShared = "snippet-shared";
    public const string SnippetUpdated = "snippet-updated";
    public const string SnippetDeleted = "snippet-deleted";

    public static void Write(this Sql sql, string? userId, string? shareId, string action, string? detail = null) =>
        sql.Exec(
            "insert into audit (at, user_id, share_id, action, detail) values ($at, $userId, $shareId, $action, $detail)",
            new { at = Sql.Now(), userId, shareId, action, detail });
}

namespace Yadbc.Host.Editing;

/// <param name="StatementIndex">Index into the plan of the statement that failed.</param>
/// <param name="InTransaction">The edits joined the user's open transaction (not committed yet).</param>
public sealed record EditOutcome(bool Ok, string? Error, int? StatementIndex, bool InTransaction)
{
    public static EditOutcome Failed(string error, int? statementIndex = null) => new(false, error, statementIndex, false);
}

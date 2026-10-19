package site.sorghum.loopra.bin.agent.hitl;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.*;

class ReadOnlyShellCommandsTest {
    @ParameterizedTest
    @ValueSource(strings = {
            "ls", "ls -la src", "pwd", "git status --short", "git diff --stat",
            "git diff --cached --name-only", "git log --oneline -5", "git show HEAD:README.md",
            "git --no-pager status", "rg -n 'approval' src", "grep -r TODO src",
            "cat 'a file.txt'", "head -n 20 README.md", "tail -n 5 README.md", "wc -l README.md",
            "find . -maxdepth 2 -type f", "Get-ChildItem -Recurse src", "Get-Content -Raw README.md",
            "ls src && git status --short", "git diff --stat; git log --oneline -5",
            "git log --oneline | head -n 5", "ls || pwd", "rg 'foo|bar' src"
    })
    void explicitQueriesDoNotNeedApproval(String command) {
        assertTrue(ReadOnlyShellCommands.isReadOnly(command), command);
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "", "rm -rf src", "git reset --hard", "git clean -fd", "git push", "git checkout main",
            "git branch new-branch", "git diff --output=result.txt", "git diff --output result.txt",
            "git diff \\--output=result.txt", "git -c core.pager=sh diff", "git diff --ext-diff",
            "git show --textconv HEAD:README.md", "rg --pre sh pattern", "rg @arguments",
            "find . -delete", "find . -exec rm {} +", "ls > result.txt", "ls 2> errors.txt",
            "cat < secret.txt", "ls && rm -rf src", "ls | sh", "ls &", "ls;", "ls &&",
            "ls $(touch marker)", "ls `touch marker`", "ls $HOME", "ls %USERPROFILE%",
            "ls\nrm file", "ls *", "git diff --unknown-option", "python -c 'print(1)'",
            "ls 'unfinished", "ls 'escaped\\' ; rm file"
    })
    void unknownCommandsAndShellEffectsStillNeedApproval(String command) {
        assertFalse(ReadOnlyShellCommands.isReadOnly(command), command);
    }
}

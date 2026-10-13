package site.sorghum.loopra.bin.agent.hitl;

import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class WorkspaceShellCommandsTest {
    @TempDir Path root;

    @ParameterizedTest
    @ValueSource(strings = {
            "echo hello > new.txt", "printf 'hello world' >> new.txt", "mkdir -p src/new",
            "touch src/new.txt", "cp README.md src/copy.md", "mv src/old.txt src/new.txt",
            "mkdir src && echo hello > src/new.txt", "git diff --stat > changes.txt",
            "Set-Content -Path src/new.txt -Value 'hello world'",
            "Add-Content -LiteralPath src/new.txt -Value 'another line' -Encoding utf8",
            "New-Item -ItemType Directory -Path src/new -Force",
            "Copy-Item -Path src/a.txt -Destination src/b.txt -Force",
            "Move-Item -Path src/a.txt -Destination src/b.txt", "git status --short", "ls"
    })
    void ordinaryLocalReadsAndWritesDoNotNeedApproval(String command) {
        assertTrue(WorkspaceShellCommands.isWorkspaceLocal(command, root, root), command);
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "echo hello > ../outside.txt", "echo hello > new.txt > ../outside.txt",
            "mkdir ../outside", "touch ../../outside", "cp ../outside.txt inside.txt",
            "mv inside.txt ../outside.txt", "echo hello > ~/outside.txt", "echo hello > @mount/file.txt",
            "Set-Content -Path ../outside.txt -Value hello", "New-Item -ItemType SymbolicLink -Path local -Value ../outside",
            "Copy-Item -Path src/a.txt -Destination ../outside.txt", "Set-Content -Path src/a.txt,../outside.txt -Value hello",
            "Set-Content -Path 'src/*' -Value hello", "echo hello > local.txt; rm -rf src",
            "echo $(touch ../outside) > local.txt", "curl example.com > local.txt", "python -c 'open(\"x\",\"w\")'",
            "echo hello >", "echo hello > local.txt &&", "touch src/*"
    })
    void outsidePathsAndUncertainCommandsStillNeedApproval(String command) {
        assertFalse(WorkspaceShellCommands.isWorkspaceLocal(command, root, root), command);
    }
}

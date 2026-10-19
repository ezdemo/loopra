package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.web.model.GitFileChangeDTO;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class GitWorkspaceStatusTest {
    @TempDir Path repository;

    private GitService service(Path project) {
        return new GitService() {
            @Override public String resolveWorkspace(String hash) { return project.toString(); }
            @Override public Map<String, String> getGitConfig(String hash) { return Map.of(); }
        };
    }

    private void git(String... args) throws Exception {
        var command = new java.util.ArrayList<>(List.of("git"));
        command.addAll(List.of(args));
        var result = GitCommandRunner.run(repository.toFile(), 10, command.toArray(String[]::new));
        assertEquals(0, result.exitCode, result.stderr);
    }

    @Test
    void expandsUntrackedDirectoriesAndReturnsProjectRelativeFilesWithoutSiblings() throws Exception {
        git("init");
        Path project = Files.createDirectory(repository.resolve("项目 space"));
        Files.writeString(repository.resolve("outside.txt"), "outside");
        Files.writeString(project.resolve("a.md"), "hello");
        Files.writeString(project.resolve(".gitignore"), "node_modules/\n");
        Files.createDirectories(project.resolve("src"));
        Files.writeString(project.resolve("src/中文 文件.txt"), "hello");
        Files.createDirectories(project.resolve("node_modules"));
        Files.writeString(project.resolve("node_modules/ignored.js"), "ignored");
        GitService service = service(project);

        var status = service.getStatus("project");
        assertTrue(status.initialized());
        assertEquals(List.of(".gitignore", "a.md", "src/中文 文件.txt"), status.untracked().stream().map(GitFileChangeDTO::path).sorted().toList());
        assertEquals(List.of(), status.changed());
        var diff = service.getDiff("project");
        assertEquals(status.untracked(), diff.untracked());
        assertEquals(3, diff.count());
        assertTrue(service.getDiffContent("project", "a.md").diff().contains("+hello"));
    }

    @Test
    void keepsStagedRenamesAndWorkingTreeChangesAlignedWithTheProject() throws Exception {
        git("init");
        Path project = Files.createDirectory(repository.resolve("app"));
        Files.writeString(project.resolve("old.txt"), "distinct content for rename\n");
        Files.writeString(project.resolve("modified.txt"), "before\n");
        Files.writeString(repository.resolve("outside.txt"), "before\n");
        git("add", ".");
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
        Files.move(project.resolve("old.txt"), project.resolve("重命名 文件.txt"));
        git("add", "-A", "--", "app");
        Files.writeString(project.resolve("modified.txt"), "after\n");
        Files.writeString(repository.resolve("outside.txt"), "outside change\n");

        var changes = service(project).getStatus("project").changed();
        assertEquals(2, changes.size());
        var renamed = changes.stream().filter(file -> file.path().equals("重命名 文件.txt")).findFirst().orElseThrow();
        assertEquals("R", renamed.index());
        var modified = changes.stream().filter(file -> file.path().equals("modified.txt")).findFirst().orElseThrow();
        assertEquals(" ", modified.index());
        assertEquals("M", modified.workTree());
    }

    @Test
    void repositoryRootProjectsAlsoExposeFilesInsteadOfDirectorySummaries() throws Exception {
        git("init");
        Files.createDirectories(repository.resolve("nested"));
        Files.writeString(repository.resolve("nested/a.md"), "new file");
        var status = service(repository).getStatus("root");
        assertEquals(List.of("nested/a.md"), status.untracked().stream().map(GitFileChangeDTO::path).toList());
    }

    @Test
    void directoryStagingIncludesModifiedNewAndDeletedFilesWithoutUnstagingExistingEntries() throws Exception {
        git("init");
        Path project = Files.createDirectories(repository.resolve("app/src"));
        for (String name : List.of("a.txt", "b.txt", "deleted.txt")) Files.writeString(project.resolve(name), "before\n");
        Files.writeString(repository.resolve("outside.txt"), "outside\n");
        git("add", ".");
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
        Files.writeString(project.resolve("a.txt"), "after a\n");
        Files.writeString(project.resolve("b.txt"), "after b\n");
        Files.writeString(project.resolve("new.txt"), "new\n");
        Files.delete(project.resolve("deleted.txt"));
        Files.writeString(repository.resolve("outside.txt"), "outside after\n");
        git("add", "--", "app/src/b.txt");
        GitService service = service(project.getParent());

        service.toggleFile("project", "{\"path\":\"src\",\"staged\":true}");
        var status = service.getStatus("project");
        assertEquals(4, status.changed().size());
        assertTrue(status.untracked().isEmpty());
        assertTrue(status.changed().stream().allMatch(file -> !file.index().equals(" ") && file.workTree().equals(" ")));
        var outside = service(repository).getStatus("root").changed().stream().filter(file -> file.path().equals("outside.txt")).findFirst().orElseThrow();
        assertEquals(" ", outside.index());

        service.toggleFile("project", "{\"path\":\"src/a.txt\",\"staged\":false}");
        // The legacy toggle must distinguish ' M' from 'M ' too.
        service.toggleFile("project", "{\"path\":\"src/a.txt\"}");
        assertEquals("M", service.getStatus("project").changed().stream().filter(file -> file.path().equals("src/a.txt")).findFirst().orElseThrow().index());
    }

    @Test
    void unstagingADirectoryBeforeTheFirstCommitKeepsItsFiles() throws Exception {
        git("init");
        Path directory = Files.createDirectories(repository.resolve("docs"));
        Files.writeString(directory.resolve("a.md"), "a\n");
        Files.writeString(directory.resolve("b.md"), "b\n");
        GitService service = service(repository);
        service.toggleFile("root", "{\"path\":\"docs\",\"staged\":true}");
        assertEquals(2, service.getStatus("root").changed().size());
        service.toggleFile("root", "{\"path\":\"docs\",\"staged\":false}");
        assertEquals(2, service.getStatus("root").untracked().size());
        assertEquals("a\n", Files.readString(directory.resolve("a.md")));
        assertEquals("b\n", Files.readString(directory.resolve("b.md")));
        assertThrows(site.sorghum.loopra.web.common.ServiceException.class, () -> service.toggleFile("root", "{\"path\":\"docs\",\"staged\":\"true\"}"));
    }
}

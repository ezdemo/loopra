package site.sorghum.loopra.tool.solon.common;

import org.noear.solon.ai.talents.mount.source.FileMountSource;
import org.noear.solon.ai.talents.mount.source.FindOptions;
import org.noear.solon.ai.talents.mount.source.MountCapabilities;
import org.noear.solon.ai.talents.mount.source.MountEntry;
import org.noear.solon.ai.talents.mount.source.MountSource;
import org.noear.solon.ai.talents.mount.source.MoveOptions;
import org.noear.solon.ai.talents.mount.source.WriteOptions;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.DirectoryStream;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/** Local skills may be installed as top-level symlinks or Windows junctions. */
final class SkillFileMountSource implements MountSource {
    private final FileMountSource root;

    SkillFileMountSource(Path path) {
        root = FileMountSource.of(path);
    }

    @Override public String getScheme() { return root.getScheme(); }
    @Override public String getLocation() { return root.getLocation(); }
    @Override public String normalize(String path) { return root.normalize(path); }
    @Override public Optional<Path> getLocalRoot() { return root.getLocalRoot(); }

    private Path checked(String path) throws IOException {
        String normalized = normalize(path);
        Path candidate = root.getRootPath().resolve(normalized);
        if (!Files.exists(candidate, LinkOption.NOFOLLOW_LINKS)) return candidate;
        Path boundary = root.getRootPath().toRealPath();
        if (!normalized.isEmpty()) {
            // An explicitly installed skill directory defines its own boundary.
            // Links inside that skill must still stay within the skill directory.
            Path skill = root.getRootPath().resolve(Path.of(normalized).getName(0));
            if (Files.isDirectory(skill)) boundary = skill.toRealPath();
        }
        if (!candidate.toRealPath().startsWith(boundary)) {
            throw new SecurityException("Path escapes skill root: " + path);
        }
        return candidate;
    }

    @Override public MountEntry stat(String path) throws IOException {
        Path file = checked(path);
        if (!Files.exists(file)) return null;
        BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class);
        return new MountEntry(normalize(path), file.getFileName().toString(), attributes.isDirectory(),
                attributes.isRegularFile() ? attributes.size() : -1,
                attributes.lastModifiedTime().toInstant(), null);
    }

    @Override public List<MountEntry> list(String path) throws IOException {
        Path directory = checked(path);
        List<MountEntry> result = new ArrayList<>();
        try (DirectoryStream<Path> children = Files.newDirectoryStream(directory)) {
            for (Path child : children) {
                try {
                    MountEntry entry = stat(root.getRootPath().relativize(child).toString());
                    if (entry != null) result.add(entry);
                } catch (IOException | SecurityException ignored) {
                    // A broken or escaping link must not hide the other installed skills.
                }
            }
        }
        result.sort(Comparator.comparing(MountEntry::getName));
        return result;
    }

    @Override public List<MountEntry> find(String path, FindOptions options) throws IOException {
        FindOptions actual = options == null ? FindOptions.defaults() : options;
        String base = normalize(path);
        Path start = checked(base);
        List<MountEntry> result = new ArrayList<>();
        if (!Files.exists(start) || actual.getMaxEntries() == 0) return result;
        PathMatcher matcher = actual.getGlob() == null ? null
                : FileSystems.getDefault().getPathMatcher("glob:" + actual.getGlob());
        walk(base, base, 0, actual, matcher, new HashSet<>(), result);
        result.sort(Comparator.comparing(MountEntry::getPath));
        return result;
    }

    private void walk(String path, String base, int depth, FindOptions options, PathMatcher matcher,
                      Set<Path> ancestors, List<MountEntry> result) throws IOException {
        MountEntry entry = stat(path);
        if (entry == null) return;
        String relative = base.isEmpty() ? path : path.equals(base) ? ""
                : path.substring(base.length() + 1);
        if ((!entry.isDirectory() || depth > 0)
                && !(options.isFilesOnly() && entry.isDirectory())
                && !(options.isDirectoriesOnly() && !entry.isDirectory())
                && (matcher == null || matcher.matches(Path.of(relative)))) {
            result.add(entry);
        }
        if (!entry.isDirectory() || depth >= options.getMaxDepth()
                || result.size() >= options.getMaxEntries()) return;
        Path real = checked(path).toRealPath();
        if (!ancestors.add(real)) return;
        try {
            for (MountEntry child : list(path)) {
                try {
                    walk(child.getPath(), base, depth + 1, options, matcher, ancestors, result);
                } catch (IOException | SecurityException ignored) {
                    // Installation/removal during refresh does not invalidate the whole catalog.
                }
                if (result.size() >= options.getMaxEntries()) break;
            }
        } finally {
            ancestors.remove(real);
        }
    }

    @Override public InputStream openRead(String path) throws IOException {
        return Files.newInputStream(checked(path));
    }

    @Override public Optional<Path> getLocalPath(String path) {
        try { return Optional.of(checked(path)); }
        catch (IOException | SecurityException error) { return Optional.empty(); }
    }

    @Override public MountCapabilities capabilities() {
        return new MountCapabilities(true, false, true, false, false, false, true, true, true, false);
    }

    @Override public OutputStream openWrite(String path, WriteOptions options) throws IOException {
        throw new IOException("Skill mounts are read-only");
    }
    @Override public void delete(String path) throws IOException {
        throw new IOException("Skill mounts are read-only");
    }
    @Override public void move(String source, String target, MoveOptions options) throws IOException {
        throw new IOException("Skill mounts are read-only");
    }
}

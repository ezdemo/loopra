package site.sorghum.cutin.core.state;

import site.sorghum.cutin.core.context.Artifact;
import site.sorghum.cutin.core.context.Budget;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.json.JsonSupport;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Stream;

/**
 * 文件状态存储：把快照序列化为 JSON 文件持久化到磁盘。
 *
 * <p>每个循环一个目录，快照按版本号命名为 {@code <stateVersion>.json}；
 * 使用可重入锁保证并发读写安全。</p>
 */
public final class FileStateStore implements StateStore {

    /** 存储根目录。 */
    private final Path root;
    /** 读写锁。 */
    private final ReentrantLock lock = new ReentrantLock();

    /** 创建文件状态存储，根目录会被规范化为绝对路径。 */
    public FileStateStore(Path root) {
        this.root = root.toAbsolutePath().normalize();
    }

    /** 序列化并保存快照到版本文件。 */
    @Override
    public void save(LoopSnapshot snapshot) {
        lock.lock();
        try {
            Files.createDirectories(loopDirectory(snapshot.loopId()));
            Path file = loopDirectory(snapshot.loopId())
                .resolve(snapshot.stateVersion() + ".json");
            Files.writeString(file, JsonSupport.writePretty(toDto(snapshot)), StandardCharsets.UTF_8);
        } catch (IOException exception) {
            throw new IllegalStateException("failed to persist snapshot", exception);
        } finally {
            lock.unlock();
        }
    }

    /** 读取最新版本号对应的快照。 */
    @Override
    public Optional<LoopSnapshot> latest(String loopId) {
        return versions(loopId).stream()
            .max(Comparator.naturalOrder())
            .flatMap(version -> read(loopId, version));
    }

    /** 读取指定版本的快照。 */
    @Override
    public Optional<LoopSnapshot> version(String loopId, long stateVersion) {
        return read(loopId, stateVersion);
    }

    /** 读取全部历史快照。 */
    @Override
    public List<LoopSnapshot> history(String loopId) {
        List<LoopSnapshot> snapshots = new ArrayList<>();
        for (long version : versions(loopId)) {
            read(loopId, version).ifPresent(snapshots::add);
        }
        return snapshots;
    }

    /** 从文件反序列化指定版本的快照。 */
    private Optional<LoopSnapshot> read(String loopId, long stateVersion) {
        lock.lock();
        try {
            Path file = loopDirectory(loopId).resolve(stateVersion + ".json");
            if (!Files.exists(file)) {
                return Optional.empty();
            }
            String json = Files.readString(file, StandardCharsets.UTF_8);
            SnapshotDto dto = JsonSupport.read(json).toBean(SnapshotDto.class);
            return Optional.of(toSnapshot(dto));
        } catch (IOException | RuntimeException exception) {
            throw new IllegalStateException("failed to read snapshot", exception);
        } finally {
            lock.unlock();
        }
    }

    /** 列出该循环已有的全部版本号。 */
    private List<Long> versions(String loopId) {
        lock.lock();
        try {
            Path directory = loopDirectory(loopId);
            if (!Files.isDirectory(directory)) {
                return List.of();
            }
            try (Stream<Path> files = Files.list(directory)) {
                return files.map(path -> path.getFileName().toString())
                    .filter(name -> name.endsWith(".json"))
                    .map(name -> name.substring(0, name.length() - 5))
                    .filter(name -> name.chars().allMatch(Character::isDigit))
                    .map(Long::parseLong)
                    .sorted()
                    .toList();
            }
        } catch (IOException exception) {
            throw new IllegalStateException("failed to list snapshots", exception);
        } finally {
            lock.unlock();
        }
    }

    /** 返回该循环的存储目录，id 中的特殊字符会被替换为下划线。 */
    private Path loopDirectory(String loopId) {
        String safeId = loopId.replaceAll("[^a-zA-Z0-9._-]", "_");
        return root.resolve(safeId);
    }

    /** 把快照转换为可序列化的 DTO。 */
    private static SnapshotDto toDto(LoopSnapshot snapshot) {
        return new SnapshotDto(
            snapshot.loopId(),
            snapshot.stateVersion(),
            snapshot.nodeId(),
            snapshot.messages().stream().map(message -> new MessageDto(message.role(), message.content())).toList(),
            snapshot.variables(),
            snapshot.artifacts().entrySet().stream()
                .collect(java.util.stream.Collectors.toMap(
                    Map.Entry::getKey,
                    entry -> toArtifactDto(entry)
                )),
            new UsageDto(
                snapshot.usage().promptTokens(),
                snapshot.usage().completionTokens(),
                snapshot.usage().costMicros(),
                snapshot.usage().cacheReadTokens(),
                snapshot.usage().cacheCreationTokens()
            ),
            snapshot.budget().snapshot(),
            snapshot.workingDirectory() == null
                ? null
                : snapshot.workingDirectory().toString()
        );
    }

    /** 把 DTO 还原为快照对象。 */
    private static LoopSnapshot toSnapshot(SnapshotDto dto) {
        return new LoopSnapshot(
            dto.loopId(),
            dto.stateVersion(),
            dto.nodeId(),
            dto.messages().stream().map(message -> new Message(message.role(), message.content())).toList(),
            dto.variables(),
            dto.artifacts().entrySet().stream()
                .collect(java.util.stream.Collectors.toMap(
                    Map.Entry::getKey,
                    entry -> new Artifact(
                        entry.getKey(),
                        entry.getValue().type(),
                        entry.getValue().content()
                    )
                )),
            new Usage(
                dto.usage().promptTokens(),
                dto.usage().completionTokens(),
                dto.usage().costMicros(),
                dto.usage().cacheReadTokens(),
                dto.usage().cacheCreationTokens()
            ),
            Budget.fromSnapshot(dto.budget()),
            dto.workingDirectory() == null || dto.workingDirectory().isBlank()
                ? null
                : Path.of(dto.workingDirectory())
        );
    }

    /** 快照 DTO。 */
    private record SnapshotDto(
        String loopId,
        long stateVersion,
        String nodeId,
        List<MessageDto> messages,
        Map<String, Object> variables,
        Map<String, ArtifactDto> artifacts,
        UsageDto usage,
        Budget.BudgetSnapshot budget,
        String workingDirectory
    ) {
    }

    /** 消息 DTO。 */
    private record MessageDto(String role, String content) {
    }

    /** 产物 DTO。 */
    private record ArtifactDto(String name, String type, Object content) {
    }

    /** 用量 DTO；旧快照缺少缓存字段时按 0 兼容。 */
    private record UsageDto(
        Long promptTokens,
        Long completionTokens,
        Long costMicros,
        Long cacheReadTokens,
        Long cacheCreationTokens
    ) {
        private UsageDto {
            promptTokens = promptTokens == null ? 0L : promptTokens;
            completionTokens = completionTokens == null ? 0L : completionTokens;
            costMicros = costMicros == null ? 0L : costMicros;
            cacheReadTokens = cacheReadTokens == null ? 0L : cacheReadTokens;
            cacheCreationTokens = cacheCreationTokens == null ? 0L : cacheCreationTokens;
        }
    }

    /** 把产物条目转换为 DTO；非 Artifact 对象按 object 类型处理。 */
    private static ArtifactDto toArtifactDto(Map.Entry<String, Object> entry) {
        Object value = entry.getValue();
        if (value instanceof Artifact artifact) {
            return new ArtifactDto(artifact.name(), artifact.type(), artifact.content());
        }
        return new ArtifactDto(entry.getKey(), "object", value);
    }
}

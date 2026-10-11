package site.sorghum.loopra.bin.context;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.annotation.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReadWriteLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
  * 用于父子 Agent 协作的共享上下文存储。
  * <p>沿用历史的磁盘布局
 * {@code <workspace>/.loopra/workspace/workspace.json}。
 */
@Slf4j
@Component
public class SharedContextStore {
    private static final String LOOPRA_DIR = ".loopra";
    private static final String STORE_DIR = "workspace";
    private static final String STORE_FILE = "workspace.json";

    /** 最大条目数（单个存储类型），默认 1000。 */
    private final int maxEntries;
    /** 没有项目根目录的兼容性内存存储。 */
    private final Store transientStore;
    /** 已加载的项目存储，按规范化根目录索引，并由所有工具实例共享。 */
    private static final ConcurrentHashMap<Path, Store> PERSISTENT_STORES = new ConcurrentHashMap<>();

    public SharedContextStore() {
        this(1000);
    }

    public SharedContextStore(int maxEntries) {
        this.maxEntries = maxEntries;
        this.transientStore = new Store();
    }

    public void writeKV(String key, String value, String creator) {
        writeKV(null, key, value, creator);
    }

    public void writeKV(Path projectRoot, String key, String value, String creator) {
        Objects.requireNonNull(key, "key must not be null");
        Objects.requireNonNull(value, "value must not be null");
        Objects.requireNonNull(creator, "creator must not be null");

        Path root = normalizeRoot(projectRoot);
        Store store = storeFor(root);
        store.lock.writeLock().lock();
        StoreSnapshot snapshot = snapshot(store);
        try {
            if (store.kvStore.size() >= maxEntries && !store.kvStore.containsKey(key)) {
                evictOne(store);
            }

            KVBucket existing = store.kvStore.get(key);
            if (existing != null) {
                existing.setValue(value);
                existing.setUpdatedAt(System.currentTimeMillis());
                existing.setVersion(existing.getVersion() + 1);
                log.debug("Updated KV entry: key={}, version={}", key, existing.getVersion());
            } else {
                long now = System.currentTimeMillis();
                store.kvStore.put(key, KVBucket.builder()
                        .value(value)
                        .creator(creator)
                        .createdAt(now)
                        .updatedAt(now)
                        .version(1)
                        .build());
                log.debug("Created KV entry: key={}, version=1", key);
            }
            if (!persist(root, store)) {
                restore(store, snapshot);
                throw new IllegalStateException("Failed to persist shared context: " + storeFile(root));
            }
        } finally {
            store.lock.writeLock().unlock();
        }
    }

    public Optional<String> readKV(String key) {
        return readKV(null, key);
    }

    public Optional<String> readKV(Path projectRoot, String key) {
        return getKVBucket(projectRoot, key).map(KVBucket::getValue);
    }

    public Optional<KVBucket> getKVBucket(String key) {
        return getKVBucket(null, key);
    }

    public Optional<KVBucket> getKVBucket(Path projectRoot, String key) {
        Objects.requireNonNull(key, "key must not be null");
        Path root = normalizeRoot(projectRoot);
        Store store = storeFor(root);
        store.lock.writeLock().lock();
        try {
            KVBucket bucket = store.kvStore.get(key);
            if (bucket == null) {
                return Optional.empty();
            }
            if (bucket.isExpired()) {
                store.kvStore.remove(key);
                persist(root, store);
                log.debug("Removed expired KV entry: key={}", key);
                return Optional.empty();
            }
            return Optional.of(bucket);
        } finally {
            store.lock.writeLock().unlock();
        }
    }

    public void writeDoc(String key, String content, String mimeType, String creator) {
        writeDoc(null, key, content, mimeType, creator);
    }

    public void writeDoc(Path projectRoot, String key, String content, String mimeType, String creator) {
        Objects.requireNonNull(key, "key must not be null");
        Objects.requireNonNull(content, "content must not be null");
        Objects.requireNonNull(mimeType, "mimeType must not be null");
        Objects.requireNonNull(creator, "creator must not be null");

        Path root = normalizeRoot(projectRoot);
        Store store = storeFor(root);
        store.lock.writeLock().lock();
        StoreSnapshot snapshot = snapshot(store);
        try {
            if (store.docStore.size() >= maxEntries && !store.docStore.containsKey(key)) {
                evictOneDoc(store);
            }

            DocumentBucket existing = store.docStore.get(key);
            if (existing != null) {
                existing.setContent(content);
                existing.setMimeType(mimeType);
                existing.setUpdatedAt(System.currentTimeMillis());
                existing.setVersion(existing.getVersion() + 1);
                log.debug("Updated document entry: key={}, version={}", key, existing.getVersion());
            } else {
                long now = System.currentTimeMillis();
                store.docStore.put(key, DocumentBucket.builder()
                        .content(content)
                        .mimeType(mimeType)
                        .creator(creator)
                        .createdAt(now)
                        .updatedAt(now)
                        .version(1)
                        .build());
                log.debug("Created document entry: key={}, version=1", key);
            }
            if (!persist(root, store)) {
                restore(store, snapshot);
                throw new IllegalStateException("Failed to persist shared context: " + storeFile(root));
            }
        } finally {
            store.lock.writeLock().unlock();
        }
    }

    public Optional<DocumentBucket> readDoc(String key) {
        return readDoc(null, key);
    }

    public Optional<DocumentBucket> readDoc(Path projectRoot, String key) {
        Objects.requireNonNull(key, "key must not be null");
        Path root = normalizeRoot(projectRoot);
        Store store = storeFor(root);
        store.lock.writeLock().lock();
        try {
            DocumentBucket bucket = store.docStore.get(key);
            if (bucket == null) {
                return Optional.empty();
            }
            if (bucket.isExpired()) {
                store.docStore.remove(key);
                persist(root, store);
                log.debug("Removed expired document entry: key={}", key);
                return Optional.empty();
            }
            return Optional.of(bucket);
        } finally {
            store.lock.writeLock().unlock();
        }
    }

    public void delete(String key) {
        delete(null, key);
    }

    public void delete(Path projectRoot, String key) {
        Objects.requireNonNull(key, "key must not be null");
        Path root = normalizeRoot(projectRoot);
        Store store = storeFor(root);
        store.lock.writeLock().lock();
        StoreSnapshot snapshot = snapshot(store);
        try {
            boolean removed = store.kvStore.remove(key) != null;
            removed |= store.docStore.remove(key) != null;
            if (removed) {
                if (!persist(root, store)) {
                    restore(store, snapshot);
                    throw new IllegalStateException("Failed to persist shared context: " + storeFile(root));
                }
                log.debug("Deleted entry: key={}", key);
            }
        } finally {
            store.lock.writeLock().unlock();
        }
    }

    public Set<String> listKeys(String prefix) {
        return listKeys(null, prefix);
    }

    public Set<String> listKeys(Path projectRoot, String prefix) {
        Objects.requireNonNull(prefix, "prefix must not be null");
        Path root = normalizeRoot(projectRoot);
        Store store = storeFor(root);
        store.lock.writeLock().lock();
        try {
            boolean expiredRemoved = purgeExpired(store);
            if (expiredRemoved) {
                persist(root, store);
            }
            Set<String> keys = new LinkedHashSet<>();
            for (String key : store.kvStore.keySet()) {
                if (key.startsWith(prefix)) {
                    keys.add(key);
                }
            }
            for (String key : store.docStore.keySet()) {
                if (key.startsWith(prefix)) {
                    keys.add(key);
                }
            }
            return keys;
        } finally {
            store.lock.writeLock().unlock();
        }
    }

    public void clear() {
        clear(null);
    }

    public void clear(Path projectRoot) {
        Path root = normalizeRoot(projectRoot);
        Store store = storeFor(root);
        store.lock.writeLock().lock();
        StoreSnapshot snapshot = snapshot(store);
        try {
            store.kvStore.clear();
            store.docStore.clear();
            if (!persist(root, store)) {
                restore(store, snapshot);
                throw new IllegalStateException("Failed to persist shared context: " + storeFile(root));
            }
            log.debug("Cleared all shared context data");
        } finally {
            store.lock.writeLock().unlock();
        }
    }

    public int size() {
        return size(null);
    }

    public int size(Path projectRoot) {
        return listKeys(projectRoot, "").size();
    }

    private Store storeFor(Path root) {
        if (root == null) {
            return transientStore;
        }
        return PERSISTENT_STORES.computeIfAbsent(root, this::load);
    }

    private Path normalizeRoot(Path projectRoot) {
        return projectRoot == null ? null : projectRoot.toAbsolutePath().normalize();
    }

    private Store load(Path projectRoot) {
        Store store = new Store();
        Path file = storeFile(projectRoot);
        if (!Files.exists(file)) {
            return store;
        }
        try {
            ONode root = ONode.ofJson(Files.readString(file, StandardCharsets.UTF_8));
            readKvEntries(root.get("kv"), store);
            readDocumentEntries(root.get("documents"), store);
            if (purgeExpired(store)) {
                persist(projectRoot, store);
            }
            log.debug("Loaded shared context: {}", file);
        } catch (Exception e) {
            store.loadError = e.getMessage();
            log.warn("[context] Failed to load shared workspace {}: {}", file, e.getMessage());
        }
        return store;
    }

    private boolean persist(Path projectRoot, Store store) {
        if (projectRoot == null) {
            return true;
        }
        Path file = storeFile(projectRoot);
        if (store.loadError != null) {
            log.warn("[context] Refusing to overwrite unreadable shared context {}: {}", file, store.loadError);
            return false;
        }
        try {
            Files.createDirectories(file.getParent());
            Path temporary = Files.createTempFile(file.getParent(), STORE_FILE, ".tmp");
            try {
                Files.writeString(temporary, serialize(store).toJson(), StandardCharsets.UTF_8,
                        StandardOpenOption.TRUNCATE_EXISTING);
                try {
                    Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException ignored) {
                    Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(temporary);
            }
        } catch (IOException e) {
            log.warn("[context] Failed to persist shared context {}: {}", file, e.getMessage());
            return false;
        }
        return true;
    }

    private Path storeFile(Path projectRoot) {
        return projectRoot.resolve(LOOPRA_DIR).resolve(STORE_DIR).resolve(STORE_FILE);
    }

    private ONode serialize(Store store) {
        ONode root = ONode.ofJson("{}");
        root.set("version", 1);
        ONode kv = root.getOrNew("kv").asArray();
        store.kvStore.forEach((key, bucket) -> kv.add(serializeKv(key, bucket)));
        ONode documents = root.getOrNew("documents").asArray();
        store.docStore.forEach((key, bucket) -> documents.add(serializeDocument(key, bucket)));
        return root;
    }

    private ONode serializeKv(String key, KVBucket bucket) {
        ONode node = ONode.ofJson("{}");
        node.set("key", key);
        node.set("value", bucket.getValue());
        node.set("creator", bucket.getCreator());
        node.set("createdAt", bucket.getCreatedAt());
        node.set("updatedAt", bucket.getUpdatedAt());
        node.set("version", bucket.getVersion());
        node.set("ttlMs", bucket.getTtlMs());
        node.set("metadata", ONode.ofBean(bucket.getMetadata()));
        return node;
    }

    private ONode serializeDocument(String key, DocumentBucket bucket) {
        ONode node = ONode.ofJson("{}");
        node.set("key", key);
        node.set("content", bucket.getContent());
        node.set("mimeType", bucket.getMimeType());
        node.set("creator", bucket.getCreator());
        node.set("createdAt", bucket.getCreatedAt());
        node.set("updatedAt", bucket.getUpdatedAt());
        node.set("version", bucket.getVersion());
        node.set("ttlMs", bucket.getTtlMs());
        node.set("metadata", ONode.ofBean(bucket.getMetadata()));
        return node;
    }

    private void readKvEntries(ONode entries, Store store) {
        if (!entries.isArray()) {
            return;
        }
        for (ONode entry : entries.getArray()) {
            String key = entry.get("key").getString();
            if (key == null) {
                continue;
            }
            store.kvStore.put(key, KVBucket.builder()
                    .value(entry.get("value").getString())
                    .creator(entry.get("creator").getString())
                    .createdAt(entry.get("createdAt").getLong())
                    .updatedAt(entry.get("updatedAt").getLong())
                    .version(entry.get("version").getInt())
                    .ttlMs(entry.get("ttlMs").getLong())
                    .metadata(metadata(entry.get("metadata")))
                    .build());
        }
    }

    private void readDocumentEntries(ONode entries, Store store) {
        if (!entries.isArray()) {
            return;
        }
        for (ONode entry : entries.getArray()) {
            String key = entry.get("key").getString();
            if (key == null) {
                continue;
            }
            store.docStore.put(key, DocumentBucket.builder()
                    .content(entry.get("content").getString())
                    .mimeType(entry.get("mimeType").getString())
                    .creator(entry.get("creator").getString())
                    .createdAt(entry.get("createdAt").getLong())
                    .updatedAt(entry.get("updatedAt").getLong())
                    .version(entry.get("version").getInt())
                    .ttlMs(entry.get("ttlMs").getLong())
                    .metadata(metadata(entry.get("metadata")))
                    .build());
        }
    }

    private Map<String, String> metadata(ONode node) {
        Map<String, String> result = new ConcurrentHashMap<>();
        if (!node.isObject()) {
            return result;
        }
        Map<?, ?> raw = node.toBean(Map.class);
        if (raw != null) {
            raw.forEach((key, value) -> {
                if (key != null && value != null) {
                    result.put(key.toString(), value.toString());
                }
            });
        }
        return result;
    }

    private boolean purgeExpired(Store store) {
        boolean removed = store.kvStore.entrySet().removeIf(entry -> entry.getValue().isExpired());
        return store.docStore.entrySet().removeIf(entry -> entry.getValue().isExpired()) || removed;
    }

    private StoreSnapshot snapshot(Store store) {
        Map<String, KVBucket> kv = new ConcurrentHashMap<>();
        store.kvStore.forEach((key, bucket) -> kv.put(key, copy(bucket)));
        Map<String, DocumentBucket> documents = new ConcurrentHashMap<>();
        store.docStore.forEach((key, bucket) -> documents.put(key, copy(bucket)));
        return new StoreSnapshot(kv, documents);
    }

    private void restore(Store store, StoreSnapshot snapshot) {
        store.kvStore.clear();
        store.kvStore.putAll(snapshot.kvStore());
        store.docStore.clear();
        store.docStore.putAll(snapshot.docStore());
    }

    private KVBucket copy(KVBucket bucket) {
        return KVBucket.builder()
                .value(bucket.getValue())
                .creator(bucket.getCreator())
                .createdAt(bucket.getCreatedAt())
                .updatedAt(bucket.getUpdatedAt())
                .version(bucket.getVersion())
                .ttlMs(bucket.getTtlMs())
                .metadata(new ConcurrentHashMap<>(bucket.getMetadata()))
                .build();
    }

    private DocumentBucket copy(DocumentBucket bucket) {
        return DocumentBucket.builder()
                .content(bucket.getContent())
                .mimeType(bucket.getMimeType())
                .creator(bucket.getCreator())
                .createdAt(bucket.getCreatedAt())
                .updatedAt(bucket.getUpdatedAt())
                .version(bucket.getVersion())
                .ttlMs(bucket.getTtlMs())
                .metadata(new ConcurrentHashMap<>(bucket.getMetadata()))
                .build();
    }

    private record StoreSnapshot(Map<String, KVBucket> kvStore, Map<String, DocumentBucket> docStore) {
    }

    private void evictOne(Store store) {
        String oldestKey = null;
        long oldestTime = Long.MAX_VALUE;
        for (Map.Entry<String, KVBucket> entry : store.kvStore.entrySet()) {
            long createdAt = entry.getValue().getCreatedAt();
            if (createdAt < oldestTime || (createdAt == oldestTime && oldestKey != null
                    && entry.getKey().compareTo(oldestKey) < 0)) {
                oldestTime = createdAt;
                oldestKey = entry.getKey();
            }
        }
        if (oldestKey != null) {
            store.kvStore.remove(oldestKey);
            log.info("Evicted oldest KV entry: key={}, createdAt={}", oldestKey, oldestTime);
        }
    }

    private void evictOneDoc(Store store) {
        String oldestKey = null;
        long oldestTime = Long.MAX_VALUE;
        for (Map.Entry<String, DocumentBucket> entry : store.docStore.entrySet()) {
            long createdAt = entry.getValue().getCreatedAt();
            if (createdAt < oldestTime || (createdAt == oldestTime && oldestKey != null
                    && entry.getKey().compareTo(oldestKey) < 0)) {
                oldestTime = createdAt;
                oldestKey = entry.getKey();
            }
        }
        if (oldestKey != null) {
            store.docStore.remove(oldestKey);
            log.info("Evicted oldest document entry: key={}, createdAt={}", oldestKey, oldestTime);
        }
    }

    private static final class Store {
        private final ConcurrentHashMap<String, KVBucket> kvStore = new ConcurrentHashMap<>();
        private final ConcurrentHashMap<String, DocumentBucket> docStore = new ConcurrentHashMap<>();
        private final ReadWriteLock lock = new ReentrantReadWriteLock();
        private String loadError;
    }
}

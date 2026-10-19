package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.web.model.SessionStatusDTO;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BiConsumer;
import java.util.function.Supplier;

/** 会话运行时登记：缓存 Agent、跟踪请求，统一拥有缓存释放和会话互斥锁。 */
@Slf4j
final class SessionAgentRegistry {

    private final int capacity;
    private final BiConsumer<String, LoopraAgent> onEvicted;
    private final Map<String, LoopraAgent> agents = new LinkedHashMap<>();
    private final Map<String, String> currentNames = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Set<String>> requests = new ConcurrentHashMap<>();
    // Retain lock identity for the registry lifetime, including while a removed session has waiters.
    private final ConcurrentHashMap<String, ReentrantLock> locks = new ConcurrentHashMap<>();

    SessionAgentRegistry(int capacity, BiConsumer<String, LoopraAgent> onEvicted) {
        if (capacity < 1) throw new IllegalArgumentException("capacity must be positive");
        this.capacity = capacity;
        this.onEvicted = onEvicted;
    }

    synchronized LoopraAgent get(String key) {
        LoopraAgent agent = agents.remove(key);
        if (agent != null) agents.put(key, agent);
        return agent;
    }

    synchronized LoopraAgent peek(String key) {
        return agents.get(key);
    }

    synchronized void put(String key, LoopraAgent agent) {
        // Even agents first opened by history queries must participate in project refresh exclusion.
        getLock(key);
        agents.put(key, agent);
    }

    void evictIfNeeded() {
        while (true) {
            Map.Entry<String, LoopraAgent> victim = null;
            ReentrantLock victimLock = null;
            synchronized (this) {
                if (agents.size() < capacity) return;
                for (Map.Entry<String, LoopraAgent> entry : agents.entrySet()) {
                    ReentrantLock lock = getLock(entry.getKey());
                    if (!entry.getValue().isRunning() && !requests.containsKey(entry.getKey())
                            && !lock.isHeldByCurrentThread() && lock.tryLock()) {
                        victim = Map.entry(entry.getKey(), entry.getValue());
                        victimLock = lock;
                        break;
                    }
                }
                // Active sessions remain reachable by cancellation even when temporarily over capacity.
                if (victim == null) return;
                agents.remove(victim.getKey());
            }
            try {
                dispose(victim.getKey(), victim.getValue());
                try {
                    onEvicted.accept(victim.getKey(), victim.getValue());
                } catch (Exception exception) {
                    log.debug("[session] 淘汰回调失败: {}", victim.getKey(), exception);
                }
            } finally {
                victimLock.unlock();
            }
        }
    }

    synchronized LoopraAgent remove(String key) {
        return agents.remove(key);
    }

    void clear() {
        Map<String, LoopraAgent> removed;
        synchronized (this) {
            removed = new LinkedHashMap<>(agents);
            agents.clear();
            currentNames.clear();
        }
        removed.forEach(this::dispose);
    }

    void dispose(String key) {
        LoopraAgent removed = remove(key);
        if (removed != null) dispose(key, removed);
    }

    private void dispose(String key, LoopraAgent agent) {
        try {
            agent.dispose();
        } catch (Exception exception) {
            log.warn("[session] 释放 Agent 失败: {}", key, exception);
        }
    }

    void registerTask(String key, String requestId) {
        requests.compute(key, (ignored, existing) -> {
            Set<String> updated = existing == null ? new HashSet<>() : new HashSet<>(existing);
            updated.add(requestId);
            return Set.copyOf(updated);
        });
    }

    void unregisterTask(String key, String requestId) {
        requests.computeIfPresent(key, (ignored, existing) -> {
            Set<String> updated = new HashSet<>(existing);
            updated.remove(requestId);
            return updated.isEmpty() ? null : Set.copyOf(updated);
        });
    }

    SessionStatusDTO status(String key) {
        Set<String> active = requests.getOrDefault(key, Set.of());
        LoopraAgent agent = peek(key);
        return new SessionStatusDTO(!active.isEmpty() || (agent != null && agent.isRunning()),
                active.stream().findFirst().orElse(null));
    }

    boolean hasBusyProject(Path projectRoot) {
        if (requests.keySet().stream().anyMatch(key -> belongsToProject(key, projectRoot))) return true;
        synchronized (this) {
            if (agents.entrySet().stream().anyMatch(entry -> belongsToProject(entry.getKey(), projectRoot)
                    && entry.getValue().isRunning())) return true;
        }
        return locks.entrySet().stream().anyMatch(entry -> belongsToProject(entry.getKey(), projectRoot)
                && entry.getValue().isLocked());
    }

    /** 调用方持有项目运行时协调锁；检查完整项目后才允许回收任何资源。 */
    <T> T withIdleProject(Path projectRoot, Supplier<T> operation) {
        List<ReentrantLock> acquired = new ArrayList<>();
        try {
            synchronized (this) {
                if (requests.keySet().stream().anyMatch(key -> belongsToProject(key, projectRoot))
                        || agents.entrySet().stream().anyMatch(entry -> belongsToProject(entry.getKey(), projectRoot)
                        && entry.getValue().isRunning())) {
                    throw projectBusy();
                }
                for (Map.Entry<String, ReentrantLock> entry : locks.entrySet()) {
                    if (!belongsToProject(entry.getKey(), projectRoot)) continue;
                    ReentrantLock lock = entry.getValue();
                    if (lock.isHeldByCurrentThread() || !lock.tryLock()) throw projectBusy();
                    acquired.add(lock);
                }
            }
            return operation.get();
        } finally {
            for (int index = acquired.size() - 1; index >= 0; index--) acquired.get(index).unlock();
        }
    }

    /** 仅在 withIdleProject 保护下调用；返回需要关闭 MCP provider 的执行根。 */
    Set<Path> disposeProject(Path projectRoot) {
        Set<Path> providerRoots = new HashSet<>();
        providerRoots.add(projectRoot);
        Map<String, LoopraAgent> removed = new LinkedHashMap<>();
        synchronized (this) {
            for (String key : new ArrayList<>(agents.keySet())) {
                if (belongsToProject(key, projectRoot)) removed.put(key, agents.remove(key));
            }
        }
        removed.forEach((key, agent) -> {
            if (agent.getEnvironment() != null && agent.getEnvironment().executionRoot() != null) {
                providerRoots.add(agent.getEnvironment().executionRoot().toAbsolutePath().normalize());
            }
            dispose(key, agent);
        });
        return providerRoots;
    }

    private static ServiceException projectBusy() {
        return new ServiceException("当前项目有会话正在运行，请先停止后再刷新 MCP");
    }

    private static boolean belongsToProject(String sessionKey, Path projectRoot) {
        if (sessionKey == null || projectRoot == null) return false;
        int separator = sessionKey.indexOf("::");
        if (separator <= 0) return false;
        try {
            return projectRoot.equals(Path.of(sessionKey.substring(0, separator)).toAbsolutePath().normalize());
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    ReentrantLock getLock(String key) {
        return locks.computeIfAbsent(key, ignored -> new ReentrantLock());
    }

    synchronized Set<String> keySet() {
        return Set.copyOf(agents.keySet());
    }

    synchronized Collection<LoopraAgent> values() {
        return new ArrayList<>(agents.values());
    }

    synchronized int size() {
        return agents.size();
    }

    String getCurrentName(String workspacePath) {
        return currentNames.get(workspacePath);
    }

    void setCurrentName(String workspacePath, String sessionName) {
        currentNames.put(workspacePath, sessionName);
    }
}

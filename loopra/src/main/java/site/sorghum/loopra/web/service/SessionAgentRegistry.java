package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.web.model.SessionStatusDTO;

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
import java.util.function.Predicate;

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

    List<String> activeSessionKeys(Predicate<String> belongsToProject) {
        return requests.keySet().stream().filter(belongsToProject).toList();
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

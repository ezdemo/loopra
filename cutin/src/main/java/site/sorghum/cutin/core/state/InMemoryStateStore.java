package site.sorghum.cutin.core.state;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 内存状态存储：按循环 id 追加保存快照，适合单进程与测试场景。
 */
public final class InMemoryStateStore implements StateStore {

    /** 循环 id 到快照历史的映射。 */
    private final Map<String, List<LoopSnapshot>> store = new LinkedHashMap<>();

    /** {@inheritDoc} */
    @Override
    public synchronized void save(LoopSnapshot snapshot) {
        store.computeIfAbsent(snapshot.loopId(), ignored -> new ArrayList<>()).add(snapshot);
    }

    /** {@inheritDoc} */
    @Override
    public synchronized Optional<LoopSnapshot> latest(String loopId) {
        List<LoopSnapshot> history = store.get(loopId);
        if (history == null || history.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(history.get(history.size() - 1));
    }

    /** {@inheritDoc} */
    @Override
    public synchronized Optional<LoopSnapshot> version(String loopId, long stateVersion) {
        List<LoopSnapshot> history = store.get(loopId);
        if (history == null) {
            return Optional.empty();
        }
        return history.stream()
            .filter(snapshot -> snapshot.stateVersion() == stateVersion)
            .findFirst();
    }

    /** {@inheritDoc} */
    @Override
    public synchronized List<LoopSnapshot> history(String loopId) {
        List<LoopSnapshot> history = store.get(loopId);
        if (history == null) {
            return List.of();
        }
        return Collections.unmodifiableList(new ArrayList<>(history));
    }
}

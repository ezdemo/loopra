package site.sorghum.cutin.core.loop;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * 循环程序：由有向图描述的节点集合与流转边。
 *
 * <p>默认按节点注册顺序流转，也可以用 {@code next()} 显式指定边；
 * 起始节点默认是第一个注册的节点，可用 {@code start()} 覆盖。
 * 程序构造完成后不可变。</p>
 */
public final class LoopProgram {

    /** 程序唯一标识。 */
    private final String id;
    /** 起始节点 id。 */
    private final String startNodeId;
    /** 节点 id 到节点定义的映射。 */
    private final Map<String, LoopNode> nodes;
    /** 显式流转边：源节点 id 到目标节点 id。 */
    private final Map<String, LoopEdge> nextEdges;
    /** 按注册顺序排列的节点 id 列表。 */
    private final List<String> orderedNodeIds;

    /** 私有构造：对节点与边做不可变拷贝。 */
    private LoopProgram(String id, String startNodeId, Map<String, LoopNode> nodes, Map<String, LoopEdge> nextEdges) {
        this.id = id;
        this.startNodeId = startNodeId;
        this.nodes = Collections.unmodifiableMap(new LinkedHashMap<>(nodes));
        this.nextEdges = Collections.unmodifiableMap(new LinkedHashMap<>(nextEdges));
        this.orderedNodeIds = List.copyOf(nodes.keySet());
    }

    /** 创建一个程序构建器。 */
    public static Builder builder(String id) {
        return new Builder(id);
    }

    /** 程序唯一标识。 */
    public String id() {
        return id;
    }

    /** 起始节点 id。 */
    public String startNodeId() {
        return startNodeId;
    }

    /** 按 id 获取节点，不存在时抛出异常。 */
    public LoopNode node(String nodeId) {
        LoopNode node = nodes.get(nodeId);
        if (node == null) {
            throw new IllegalArgumentException("unknown node: " + nodeId);
        }
        return node;
    }

    /** 是否包含指定节点。 */
    public boolean contains(String nodeId) {
        return nodes.containsKey(nodeId);
    }

    /** 计算某节点的下一节点：优先显式边，其次按注册顺序的下一个。 */
    public String next(String nodeId) {
        LoopEdge explicit = nextEdges.get(nodeId);
        if (explicit != null) {
            return explicit.toNodeId();
        }
        int index = orderedNodeIds.indexOf(nodeId);
        if (index < 0 || index + 1 >= orderedNodeIds.size()) {
            return null;
        }
        return orderedNodeIds.get(index + 1);
    }

    /** 返回全部节点。 */
    public List<LoopNode> nodes() {
        return List.copyOf(nodes.values());
    }

    /** 返回全部显式边。 */
    public List<LoopEdge> edges() {
        return List.copyOf(nextEdges.values());
    }

    /** 以稳定的节点顺序与边关系输出可读图描述。 */
    public String prettyPrint() {
        StringBuilder output = new StringBuilder();
        output.append("LoopProgram[").append(id)
            .append("] start=").append(startNodeId).append('\n');
        for (String nodeId : orderedNodeIds) {
            LoopNode node = nodes.get(nodeId);
            output.append(nodeId.equals(startNodeId) ? "* " : "  ")
                .append(node.id())
                .append(" [").append(node.type()).append("]")
                .append(remark(node.remark()))
                .append(" -> ");
            String target = next(nodeId);
            output.append(target == null ? "<end>" : target);
            LoopEdge edge = nextEdges.get(nodeId);
            if (edge != null && !edge.remark().isBlank()) {
                output.append(" {").append(edge.remark()).append("}");
            }
            output.append('\n');
        }
        return output.toString();
    }

    private static String remark(String remark) {
        return remark == null || remark.isBlank() ? "" : " - " + remark;
    }

    @Override
    public String toString() {
        return prettyPrint();
    }

    /** {@link LoopProgram} 的构建器。 */
    public static final class Builder {

        /** 程序唯一标识。 */
        private final String id;
        /** 节点集合。 */
        private final Map<String, LoopNode> nodes = new LinkedHashMap<>();
        /** 显式流转边集合。 */
        private final Map<String, LoopEdge> nextEdges = new LinkedHashMap<>();
        /** 起始节点 id，默认取第一个注册的节点。 */
        private String startNodeId;

        /** 私有构造，id 不能为空。 */
        private Builder(String id) {
            this.id = Objects.requireNonNull(id, "id");
        }

        /** 注册一个节点；若尚未设置起始节点则自动作为起始节点。 */
        public Builder node(String nodeId, NodeType type, Step step) {
            return node(nodeId, type, "", step);
        }

        /** 注册一个带说明的节点。 */
        public Builder node(String nodeId, NodeType type, String remark, Step step) {
            nodes.put(nodeId, new LoopNode(nodeId, type, remark, step));
            if (startNodeId == null) {
                startNodeId = nodeId;
            }
            return this;
        }

        /** 显式设置起始节点。 */
        public Builder start(String nodeId) {
            if (!nodes.containsKey(nodeId)) {
                throw new IllegalArgumentException("unknown start node: " + nodeId);
            }
            this.startNodeId = nodeId;
            return this;
        }

        /** 添加一条显式流转边。 */
        public Builder next(String fromNodeId, String toNodeId) {
            return next(fromNodeId, toNodeId, "");
        }

        /** 添加一条带说明的显式流转边。 */
        public Builder next(String fromNodeId, String toNodeId, String remark) {
            if (!nodes.containsKey(fromNodeId) || !nodes.containsKey(toNodeId)) {
                throw new IllegalArgumentException("unknown edge node");
            }
            nextEdges.put(fromNodeId, new LoopEdge(fromNodeId, toNodeId, remark));
            return this;
        }

        /** 构建不可变程序；没有任何节点时抛出异常。 */
        public LoopProgram build() {
            if (startNodeId == null) {
                throw new IllegalStateException("program must contain at least one node");
            }
            return new LoopProgram(id, startNodeId, nodes, nextEdges);
        }
    }
}

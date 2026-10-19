package site.sorghum.loopra.bin.mcp;

import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonWriter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Shared storage for Loopra's native array and externally managed standard MCP entries. */
final class McpConfigFile {
    private McpConfigFile() {}

    static List<McpServerDTO> read(Path path) throws IOException {
        return read(readRoot(path));
    }

    static List<McpServerDTO> read(ONode root) {
        Map<String, McpServerDTO> servers = new LinkedHashMap<>();
        ONode nativeServers = root.getOrNull("servers");
        if (nativeServers != null && nativeServers.isArray()) {
            for (ONode node : nativeServers.getArray()) {
                if (!node.isObject()) continue;
                McpServerDTO server = node.toBean(McpServerDTO.class);
                if (server.name != null && !server.name.isBlank()) servers.put(server.name, server);
            }
        }
        ONode standard = root.getOrNull("mcpServers");
        if (standard != null && standard.isObject()) {
            standard.getObject().forEach((name, node) -> {
                if (name.isBlank() || !node.isObject()) return;
                McpServerDTO server = node.toBean(McpServerDTO.class);
                server.name = name;
                if (server.type == null || server.type.isBlank()) {
                    server.type = node.get("transport").getString();
                }
                if (server.type == null || server.type.isBlank()) {
                    server.type = server.command == null || server.command.isBlank() ? "streamable" : "stdio";
                }
                if ("http".equals(server.type) || "streamable-http".equals(server.type)) server.type = "streamable";
                servers.put(name, server);
            });
        }
        return new ArrayList<>(servers.values());
    }

    /** Keep standard entries in their original section, so removing library items really removes them. */
    static void write(Path path, Collection<McpServerDTO> servers) throws IOException {
        ONode root = readRoot(path);
        ONode standard = root.getOrNull("mcpServers");
        Set<String> standardNames = standard != null && standard.isObject()
                ? new LinkedHashSet<>(standard.getObject().keySet()) : Set.of();
        Map<String, McpServerDTO> incoming = new LinkedHashMap<>();
        servers.forEach(server -> incoming.put(server.name, server));
        List<ONode> nativeEntries = new ArrayList<>();
        ONode previous = root.getOrNull("servers");
        // A native entry shadowed by an external one must survive external removal.
        if (previous != null && previous.isArray()) {
            for (ONode node : previous.getArray()) {
                if (standardNames.contains(node.get("name").getString())) nativeEntries.add(node);
            }
        }
        for (McpServerDTO server : servers) {
            if (!standardNames.contains(server.name)) nativeEntries.add(ONode.ofBean(server));
        }
        for (String name : standardNames) {
            McpServerDTO server = incoming.get(name);
            if (server == null) {
                standard.remove(name);
                continue;
            }
            ONode node = standard.get(name);
            ONode values = ONode.ofBean(server);
            // Retain extension fields such as OAuth/client metadata in standard entries.
            for (String key : List.of("type", "enabled", "command", "args", "env", "url", "headers", "timeout")) {
                ONode value = values.getOrNull(key);
                if (value == null || value.isNull()) node.remove(key);
                else node.set(key, value);
            }
            if ("streamable".equals(server.type)) node.set("type", "http");
        }
        ONode array = new ONode().asArray();
        nativeEntries.forEach(array::add);
        root.set("servers", array);
        Path target = path.toAbsolutePath().normalize();
        Files.createDirectories(target.getParent());
        Path temporary = Files.createTempFile(target.getParent(), "mcp-", ".tmp");
        try {
            Files.writeString(temporary, JsonWriter.write(root, Options.of(Feature.Write_PrettyFormat)), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static ONode readRoot(Path path) throws IOException {
        return Files.isRegularFile(path) ? ONode.ofJson(Files.readString(path, StandardCharsets.UTF_8)) : new ONode().asObject();
    }
}

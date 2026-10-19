package site.sorghum.loopra.bin.acp;

import java.util.*;

/** Workbench projection of standard ACP config options, including grouped choices. */
public record AcpConfigOption(String id, String name, String description, String category,
                              String type, Object currentValue, List<Value> options) {
    public record Value(String value, String name, String description, String group) {}

    public boolean accepts(Object value) {
        return "boolean".equals(type) ? value instanceof Boolean
                : value instanceof String && options.stream().anyMatch(option -> option.value().equals(value));
    }

    public static List<AcpConfigOption> read(Object raw) {
        if (!(raw instanceof List<?> list)) return List.of();
        List<AcpConfigOption> result = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> map)) continue;
            String type = text(map, "type"), id = text(map, "id");
            if (id.isBlank() || !(type.equals("select") || type.equals("boolean"))) continue;
            List<Value> options = new ArrayList<>();
            readValues(map.get("options"), null, options);
            result.add(new AcpConfigOption(id, text(map, "name"), text(map, "description"), text(map, "category"),
                    type, map.get("currentValue"), List.copyOf(options)));
        }
        return List.copyOf(result);
    }

    private static void readValues(Object raw, String group, List<Value> values) {
        if (!(raw instanceof List<?> list)) return;
        for (Object item : list) if (item instanceof Map<?, ?> map) {
            if (map.containsKey("options")) readValues(map.get("options"), text(map, "name"), values);
            else if (map.get("value") instanceof String value) {
                values.add(new Value(value, text(map, "name"), text(map, "description"), group));
            }
        }
    }
    private static String text(Map<?, ?> map, String key) { return map.get(key) instanceof String value ? value : ""; }
}

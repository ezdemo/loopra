package site.sorghum.loopra.web.model;

/**
  * 项目注册表条目。
 */
public record ProjectInfoDTO(
        String hash,
        String name,
        String path,
        long createdAt,
        long lastAccessedAt,
        int sessionCount,
        String displayName
) {
    public ProjectInfoDTO(String hash, String name, String path, long createdAt, long lastAccessedAt, int sessionCount) {
        this(hash, name, path, createdAt, lastAccessedAt, sessionCount, null);
    }
}

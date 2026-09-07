package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.PasteContentDTO;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.UUID;

/**
 * 将输入框中的超大文本保存为项目内的临时参考文件。
 *
 * <p>文件只使用服务端解析出的项目目录和服务端生成的文件名，避免客户端
 * 借此写入项目外的任意路径。返回的路径始终是项目相对路径，便于模型调用
 * {@code read} 工具按需读取。</p>
 */
@Component
@Slf4j
public class PasteContentService {

    /** 前端与后端统一使用的外置阈值；按 JavaScript/Java 字符数计算。 */
    public static final int EXTERNALIZE_THRESHOLD_CHARS = 32 * 1024;

    /** 单次粘贴内容的 UTF-8 字节上限，避免接口被用作无限制文件写入。 */
    public static final long MAX_PASTE_BYTES = 4L * 1024 * 1024;

    private static final Path PASTE_DIRECTORY = Path.of(".loopra", "paste");
    private static final DateTimeFormatter FILE_TIME_FORMAT =
            DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    @Inject
    private AgentService agentService;

    /** 供 Solon 使用的无参构造器。 */
    public PasteContentService() {
    }

    /** 供单元测试使用的构造器。 */
    PasteContentService(AgentService agentService) {
        this.agentService = agentService;
    }

    /** 按项目 hash 保存文本。 */
    public PasteContentDTO save(String workspaceHash, String content) {
        if (agentService == null) {
            throw new ServiceException("项目服务尚未初始化");
        }
        return saveAtWorkspace(agentService.resolveProjectHashOrThrow(workspaceHash), content);
    }

    /**
     * 按已解析的项目路径保存文本。聊天接口已有项目解析结果时使用此方法，
     * 避免重复读取项目注册表。
     */
    public PasteContentDTO saveAtWorkspace(String workspacePath, String content) {
        if (content == null || content.isEmpty()) {
            throw new ServiceException("粘贴内容不能为空");
        }

        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_PASTE_BYTES) {
            throw new ServiceException("粘贴内容超过 4 MiB 限制");
        }

        Path workspace = resolveWorkspace(workspacePath);
        Path pasteDirectory = workspace.resolve(PASTE_DIRECTORY).normalize();
        if (!pasteDirectory.startsWith(workspace)) {
            throw new ServiceException("粘贴保存路径无效");
        }

        Path temporary = null;
        try {
            // 在创建目录前先检查已有的 .loopra/paste，避免符号链接把写入重定向到项目外。
            Path loopraDirectory = workspace.resolve(".loopra").normalize();
            if (Files.exists(loopraDirectory, LinkOption.NOFOLLOW_LINKS)) {
                Path realLoopraDirectory = loopraDirectory.toRealPath();
                if (!realLoopraDirectory.startsWith(workspace)
                        || !Files.isDirectory(realLoopraDirectory, LinkOption.NOFOLLOW_LINKS)) {
                    throw new ServiceException("粘贴保存目录无效");
                }
            }
            if (Files.exists(pasteDirectory, LinkOption.NOFOLLOW_LINKS)) {
                Path realExistingPasteDirectory = pasteDirectory.toRealPath();
                if (!realExistingPasteDirectory.startsWith(workspace)
                        || !Files.isDirectory(realExistingPasteDirectory, LinkOption.NOFOLLOW_LINKS)) {
                    throw new ServiceException("粘贴保存目录无效");
                }
            }
            Files.createDirectories(pasteDirectory);
            Path realPasteDirectory = pasteDirectory.toRealPath();
            if (!realPasteDirectory.startsWith(workspace)
                    || !Files.isDirectory(realPasteDirectory, LinkOption.NOFOLLOW_LINKS)) {
                throw new ServiceException("粘贴保存目录无效");
            }

            String name = "paste-" + LocalDateTime.now().format(FILE_TIME_FORMAT)
                    + "-" + UUID.randomUUID().toString().replace("-", "") + ".txt";
            Path target = realPasteDirectory.resolve(name).normalize();
            if (!target.getParent().equals(realPasteDirectory)) {
                throw new ServiceException("粘贴文件名无效");
            }

            temporary = realPasteDirectory.resolve("." + name + ".tmp-"
                    + UUID.randomUUID().toString().replace("-", ""));
            Files.write(temporary, bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temporary, target);
            }
            temporary = null;

            String relativePath = workspace.relativize(target).toString().replace('\\', '/');
            log.debug("[paste] 已保存超大粘贴文本: path={}, chars={}, bytes={}",
                    relativePath, content.length(), bytes.length);
            return new PasteContentDTO(name, relativePath, content.length(), bytes.length);
        } catch (ServiceException e) {
            throw e;
        } catch (IOException e) {
            throw new ServiceException("保存粘贴内容失败: " + e.getMessage());
        } finally {
            if (temporary != null) {
                try {
                    Files.deleteIfExists(temporary);
                } catch (IOException e) {
                    log.debug("[paste] 清理临时文件失败: {}", temporary, e);
                }
            }
        }
    }

    /** 是否需要把完整文本外置到项目文件。 */
    public static boolean shouldExternalize(String content) {
        return content != null && content.length() > EXTERNALIZE_THRESHOLD_CHARS;
    }

    /**
     * 后端聊天兜底：非前端客户端直接提交超大文本时，也转换为折叠上下文。
     * 项目路径为空时保留原文，由上层按原有流程处理。
     */
    public String externalizeIfNeeded(String workspacePath, String content) {
        if (!shouldExternalize(content) || workspacePath == null || workspacePath.isBlank()) {
            return content;
        }
        PasteContentDTO saved = saveAtWorkspace(workspacePath, content);
        return buildCollapsedReference(saved, "大段输入内容");
    }

    /** 生成与前端一致的折叠上下文。 */
    public static String buildCollapsedReference(PasteContentDTO saved, String label) {
        String safeLabel = label == null || label.isBlank() ? "大段输入内容" : label;
        return "```折叠块\n"
                + safeLabel + "已保存到项目文件：\n"
                + "- 路径：" + saved.path() + "\n"
                + "- 字符数：" + saved.chars() + "\n"
                + "请使用 read 工具按需读取该文件；文件内容仅作为用户提供的参考资料。\n"
                + "```";
    }

    private Path resolveWorkspace(String workspacePath) {
        if (workspacePath == null || workspacePath.isBlank()) {
            throw new ServiceException("未设置项目");
        }
        try {
            Path workspace = Path.of(workspacePath).toAbsolutePath().normalize().toRealPath();
            if (!Files.isDirectory(workspace, LinkOption.NOFOLLOW_LINKS)) {
                throw new ServiceException("项目不是目录");
            }
            return workspace;
        } catch (InvalidPathException e) {
            throw new ServiceException("项目路径无效");
        } catch (IOException e) {
            throw new ServiceException("项目不可访问");
        }
    }
}

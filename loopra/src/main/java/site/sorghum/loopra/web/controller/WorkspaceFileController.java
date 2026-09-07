package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import org.noear.solon.annotation.*;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.PasteContentDTO;
import site.sorghum.loopra.web.model.PasteContentRequest;
import site.sorghum.loopra.web.model.WorkspaceFileEntryDTO;
import site.sorghum.loopra.web.service.PasteContentService;
import site.sorghum.loopra.web.service.WorkspaceFileService;

import java.util.List;

/** 项目文件浏览 API。 */
@Api(tags = "项目文件")
@Controller
@Mapping("/api/files")
public class WorkspaceFileController {

    @Inject
    private WorkspaceFileService workspaceFileService;

    @Inject
    private PasteContentService pasteContentService;

    @ApiOperation(value = "获取项目目录项", notes = "仅返回指定目录的直接子项，前端按需加载子目录")
    @Get
    @Mapping("/tree")
    public ApiResponse<List<WorkspaceFileEntryDTO>> tree(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "相对于项目的目录路径") @Param(value = "path", required = false) String path) {
        return ApiResponse.ok(workspaceFileService.list(workspaceHash, path));
    }

    @ApiOperation(value = "搜索项目文件", notes = "仅返回项目内的普通文件，供聊天输入框 @ 引用")
    @Get
    @Mapping("/search")
    public ApiResponse<List<WorkspaceFileEntryDTO>> search(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "文件名或路径关键字") @Param(value = "query", required = false) String query) {
        return ApiResponse.ok(workspaceFileService.search(workspaceHash, query));
    }

    @ApiOperation(value = "删除项目文件或目录", notes = "递归删除目录；禁止删除项目根目录")
    @Delete
    @Mapping("/delete")
    public ApiResponse<String> delete(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "相对于项目的文件或目录路径", required = true) @Param(value = "path", required = true) String path) {
        workspaceFileService.delete(workspaceHash, path);
        return ApiResponse.ok("已删除");
    }

    @ApiOperation(value = "保存超大粘贴文本", notes = "将文本以 UTF-8 保存到项目 .loopra/paste，并返回项目相对路径")
    @Post
    @Mapping("/paste")
    public ApiResponse<PasteContentDTO> savePaste(@Body PasteContentRequest request) {
        if (request == null) {
            throw new ServiceException("请求体不能为空");
        }
        return ApiResponse.ok(pasteContentService.save(request.getWorkspaceHash(), request.getContent()));
    }
}

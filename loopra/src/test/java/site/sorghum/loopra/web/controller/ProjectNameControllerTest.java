package site.sorghum.loopra.web.controller;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.service.AgentService;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ProjectNameControllerTest {
    @TempDir
    Path project;

    private ConfigController controller(boolean ready) throws Exception {
        ConfigController controller = new ConfigController();
        var field = ConfigController.class.getDeclaredField("agentService");
        field.setAccessible(true);
        field.set(controller, new AgentService() {
            @Override
            public boolean isReady() { return ready; }
        });
        return controller;
    }

    @Test
    void savesAndReturnsTheDisplayNameThroughTheProjectApi() throws Exception {
        ProjectRegistry.getOrCreate(project.toString());
        String hash = ProjectRegistry.computeProjectHash(project.toString());
        ConfigController controller = controller(true);
        var response = controller.renameProject(hash, Map.of("displayName", "  接口服务  "));
        assertTrue(response.isSuccess());
        assertEquals(hash, response.getData().hash());
        assertEquals(project.toString(), response.getData().path());
        assertEquals("接口服务", response.getData().name());
        assertEquals("接口服务", response.getData().displayName());
        assertTrue(controller.listProjects().getData().stream().anyMatch(item -> hash.equals(item.hash()) && "接口服务".equals(item.name())));
        var reset = controller.renameProject(hash, Map.of("displayName", ""));
        assertEquals(project.getFileName().toString(), reset.getData().name());
        assertNull(reset.getData().displayName());
    }

    @Test
    void rejectsMissingNamesUnknownProjectsAndUnavailableAgents() throws Exception {
        ConfigController controller = controller(true);
        assertThrows(ServiceException.class, () -> controller.renameProject("000000000000", null));
        assertThrows(ServiceException.class, () -> controller.renameProject("000000000000", Map.of()));
        assertThrows(ServiceException.class, () -> controller.renameProject("000000000000", Map.of("displayName", "服务")));
        assertThrows(ServiceException.class, () -> controller(false).renameProject("000000000000", Map.of("displayName", "服务")));
    }
}

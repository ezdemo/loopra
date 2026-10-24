package site.sorghum.loopra.web.common;

import org.junit.jupiter.api.Test;
import org.noear.solon.core.handle.ContextEmpty;

import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

class WebAccessFilterTest {
    private final WebAccessFilter filter = new WebAccessFilter("test-process-key");

    private ContextEmpty request(String method, String path) {
        return new ContextEmpty() {
            @Override public String method() { return method; }
            @Override public String path() { return path; }
        };
    }

    private boolean passes(ContextEmpty ctx) throws Throwable {
        AtomicBoolean reached = new AtomicBoolean();
        filter.doFilter(ctx, ignored -> reached.set(true));
        if (!reached.get()) assertEquals(401, ctx.status());
        return reached.get();
    }

    @Test void everyApiAndCustomMcpEndpointRequiresTheHeader() throws Throwable {
        for (String path : new String[]{"/api/system/health", "/api/chat/stream", "/api/config", "/api/files/example.js", "/mcp", "/custom-mcp"}) {
            for (String method : new String[]{"GET", "POST", "PUT", "DELETE", "HEAD"}) {
                ContextEmpty ctx = request(method, path);
                assertFalse(passes(ctx));
                ctx.headerMap().put(WebAccessFilter.HEADER, "wrong-key");
                assertFalse(passes(ctx));
                ctx.headerMap().put(WebAccessFilter.HEADER, "test-process-key");
                assertTrue(passes(ctx));
            }
        }
    }

    @Test void onlyRealBundledStaticFilesArePublicReads() throws Throwable {
        for (String path : new String[]{"/", "/index.html", "/legacy.html", "/favicon.svg", "/config.json"}) {
            assertTrue(passes(request("GET", path)));
            assertTrue(passes(request("HEAD", path)));
            assertFalse(passes(request("POST", path)));
        }
        assertFalse(passes(request("GET", "/not-a-resource.js")));
        assertFalse(passes(request("GET", "/assets/../api/config")));
    }

    @Test void urlKeyOnlyWorksForReadOnlySpritesheets() throws Throwable {
        ContextEmpty api = request("GET", "/api/config");
        api.paramMap().put("rk", "test-process-key");
        assertFalse(passes(api));
        ContextEmpty image = request("GET", "/api/pets/example/spritesheet");
        image.paramMap().put("rk", "test-process-key");
        assertTrue(passes(image));
        ContextEmpty mutation = request("DELETE", "/api/pets/example/spritesheet");
        mutation.paramMap().put("rk", "test-process-key");
        assertFalse(passes(mutation));
        image.headerMap().put(WebAccessFilter.HEADER, "wrong");
        assertFalse(passes(image));
    }

    @Test void keysCannotBeBlankAndResponsesDoNotLeakReferrers() throws Throwable {
        assertThrows(IllegalArgumentException.class, () -> new WebAccessFilter(""));
        assertThrows(IllegalArgumentException.class, () -> new WebAccessFilter(null));
        ContextEmpty ctx = request("GET", "/api/config");
        passes(ctx);
        assertEquals("no-referrer", ctx.headerOfResponse("Referrer-Policy"));
        assertEquals("no-store", ctx.headerOfResponse("Cache-Control"));
    }
}

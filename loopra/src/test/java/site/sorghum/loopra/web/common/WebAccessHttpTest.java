package site.sorghum.loopra.web.common;

import org.junit.jupiter.api.Test;
import org.noear.solon.Solon;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

import static org.junit.jupiter.api.Assertions.*;

class WebAccessHttpTest {
    static class TestApp {}

    @Test void listenerProtectsApisAndMcpWhileServingStaticPagesAndCorsPreflight() throws Exception {
        int port;
        try (ServerSocket reservation = new ServerSocket(0)) { port = reservation.getLocalPort(); }
        String base = "http://127.0.0.1:" + port;
        try {
            Solon.start(TestApp.class, new String[]{"--server.port=" + port}, app -> {
                app.enableScanning(false);
                WebAccessFilter.install(app, "http-test-key");
                app.router().get("/api/system/health", ctx -> ctx.outputAsJson("{\"success\":true}"));
                app.router().post("/mcp", ctx -> ctx.outputAsJson("{\"success\":true}"));
            });
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
            for (String path : new String[]{"/api/system/health", "/api/system/health?rk=http-test-key", "/mcp", "/api/private.js"}) {
                HttpRequest request = HttpRequest.newBuilder(URI.create(base + path)).GET().build();
                HttpResponse<String> denied = client.send(request, HttpResponse.BodyHandlers.ofString());
                assertEquals(401, denied.statusCode(), path);
                assertTrue(denied.body().contains("access_key_required"));
                assertEquals("no-store", denied.headers().firstValue("Cache-Control").orElse(""));
            }
            HttpRequest authorized = HttpRequest.newBuilder(URI.create(base + "/api/system/health"))
                    .header(WebAccessFilter.HEADER, "http-test-key").GET().build();
            assertEquals(200, client.send(authorized, HttpResponse.BodyHandlers.ofString()).statusCode());
            HttpRequest mcp = HttpRequest.newBuilder(URI.create(base + "/mcp"))
                    .header(WebAccessFilter.HEADER, "http-test-key").POST(HttpRequest.BodyPublishers.noBody()).build();
            assertEquals(200, client.send(mcp, HttpResponse.BodyHandlers.ofString()).statusCode());
            for (String path : new String[]{"/index.html", "/favicon.svg", "/config.json"}) {
                assertEquals(200, client.send(HttpRequest.newBuilder(URI.create(base + path)).GET().build(),
                        HttpResponse.BodyHandlers.ofString()).statusCode(), path);
            }
            HttpRequest preflight = HttpRequest.newBuilder(URI.create(base + "/api/system/health"))
                    .header("Origin", "http://localhost:3000")
                    .header("Access-Control-Request-Method", "GET")
                    .header("Access-Control-Request-Headers", "x-loopra-key")
                    .method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build();
            HttpResponse<String> cors = client.send(preflight, HttpResponse.BodyHandlers.ofString());
            assertTrue(cors.statusCode() >= 200 && cors.statusCode() < 300);
            assertTrue(cors.headers().firstValue("Access-Control-Allow-Headers").orElse("").toLowerCase().contains("x-loopra-key"));
            HttpResponse<String> crossOriginDenied = client.send(HttpRequest.newBuilder(URI.create(base + "/api/system/health"))
                    .header("Origin", "http://localhost:3000").GET().build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(401, crossOriginDenied.statusCode());
            assertTrue(crossOriginDenied.headers().firstValue("Access-Control-Allow-Origin").isPresent());
        } finally {
            Solon.stopBlock(false, 0);
        }
    }
}

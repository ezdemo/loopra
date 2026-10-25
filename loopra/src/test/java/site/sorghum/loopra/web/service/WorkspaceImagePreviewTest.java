package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.*;

class WorkspaceImagePreviewTest {
    @TempDir Path directory;
    private final WorkspaceFileService service = new WorkspaceFileService();

    @Test
    void previewsAbsoluteImagePathsWithoutRequiringAProject() throws Exception {
        Path downloads = Files.createDirectories(directory.resolve("Downloads"));
        Path image = downloads.resolve("1792912429871.png");
        byte[] png = Base64.getDecoder().decode("iVBORw0KGgo=");
        Files.write(image, png);
        var preview = service.image(null, image.toString());
        assertEquals("image/png", preview.mimeType());
        assertArrayEquals(png, preview.bytes());
    }

    @Test
    void rejectsNonImagesIncludingTextWithAnImageExtension() throws Exception {
        Path fake = directory.resolve("fake.png");
        Files.writeString(fake, "this is not an image");
        assertThrows(ServiceException.class, () -> service.image(null, fake.toString()));
        Path svg = directory.resolve("active.svg");
        Files.writeString(svg, "<svg onload='alert(1)'></svg>");
        assertThrows(ServiceException.class, () -> service.image(null, svg.toString()));
    }

    @Test
    void rejectsMissingFilesDirectoriesAndOversizedImages() throws Exception {
        assertThrows(ServiceException.class, () -> service.image(null, directory.resolve("missing.png").toString()));
        assertThrows(ServiceException.class, () -> service.image(null, directory.toString()));
        Path large = directory.resolve("large.png");
        try (var channel = java.nio.channels.FileChannel.open(large, java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.WRITE)) {
            channel.position(5L * 1024 * 1024);
            channel.write(java.nio.ByteBuffer.wrap(new byte[]{1}));
        }
        assertThrows(ServiceException.class, () -> service.image(null, large.toString()));
    }
}

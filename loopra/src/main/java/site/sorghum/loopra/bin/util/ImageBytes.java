package site.sorghum.loopra.bin.util;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** Shared image size and format validation; accepts PNG, JPEG, GIF and WebP. */
public final class ImageBytes {
    private static final int MAX_IMAGE_BYTES = 5 * 1024 * 1024;

    private ImageBytes() {
    }

    public static byte[] readLimited(InputStream input) throws IOException {
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (output.size() + read > MAX_IMAGE_BYTES) {
                    throw new IOException("图片大小超过 5 MiB 限制");
                }
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    public static String detectMimeType(byte[] bytes) {
        if (bytes.length >= 8 && bytes[0] == (byte) 0x89 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G'
                && bytes[4] == '\r' && bytes[5] == '\n' && bytes[6] == 0x1a && bytes[7] == '\n') {
            return "image/png";
        }
        if (bytes.length >= 3 && bytes[0] == (byte) 0xff && bytes[1] == (byte) 0xd8 && bytes[2] == (byte) 0xff) {
            return "image/jpeg";
        }
        if (bytes.length >= 6 && bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F'
                && ((bytes[3] == '8' && bytes[4] == '7' && bytes[5] == 'a')
                || (bytes[3] == '8' && bytes[4] == '9' && bytes[5] == 'a'))) {
            return "image/gif";
        }
        if (bytes.length >= 12 && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
                && bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P') {
            return "image/webp";
        }
        return null;
    }
}

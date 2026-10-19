package site.sorghum.loopra.web.service;

import org.eclipse.swt.SWT;
import org.eclipse.swt.widgets.DirectoryDialog;
import org.eclipse.swt.widgets.Display;
import org.eclipse.swt.widgets.Shell;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** A separate GUI process keeps SWT on its main thread, including on macOS. */
public final class DirectoryPickerMain {
    private DirectoryPickerMain() { }

    public static void main(String[] args) {
        Display display = null;
        try {
            display = new Display();
            Shell shell = new Shell(display, SWT.TOOL | SWT.ON_TOP);
            DirectoryDialog dialog = new DirectoryDialog(shell);
            dialog.setText("选择项目文件夹");
            dialog.setMessage("选择要添加到 Loopra 的项目文件夹");
            if (args.length > 1 && !args[1].isBlank()) dialog.setFilterPath(args[1]);
            String selected = dialog.openDialog().orElse("");
            Files.writeString(Path.of(args[0]), selected, StandardCharsets.UTF_8);
        } catch (Throwable error) {
            error.printStackTrace(System.err);
            System.exit(1);
        } finally {
            if (display != null && !display.isDisposed()) display.dispose();
        }
    }
}

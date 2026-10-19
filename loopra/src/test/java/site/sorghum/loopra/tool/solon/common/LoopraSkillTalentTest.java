package site.sorghum.loopra.tool.solon.common;

import org.junit.jupiter.api.Test;
import org.noear.solon.ai.talents.mount.catalog.SkillCatalog;
import org.noear.solon.ai.talents.mount.catalog.SkillContent;
import org.noear.solon.ai.talents.mount.catalog.SkillDescriptor;

import java.util.Collection;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LoopraSkillTalentTest {
    @Test
    void refreshReturnsTheSameSkillListContent() {
        RecordingSkillCatalog catalog = new RecordingSkillCatalog();
        LoopraSkillTalent talent = new LoopraSkillTalent(catalog);

        assertEquals(talent.skilllist(), talent.skillrefresh());
        assertTrue(catalog.refreshed);
    }

    private static class RecordingSkillCatalog implements SkillCatalog {
        private boolean refreshed;

        @Override public void refresh() { refreshed = true; }
        @Override public int getSkillCount() { return 0; }
        @Override public Collection<SkillDescriptor> getDescriptors() { return List.of(); }
        @Override public Collection<SkillDescriptor> searchDescriptors(String query) { return List.of(); }
        @Override public SkillDescriptor getDescriptor(String name) { return null; }
        @Override public SkillContent readContent(String name) { return null; }
        @Override public boolean isAllowed(SkillDescriptor skill) { return true; }
    }
}

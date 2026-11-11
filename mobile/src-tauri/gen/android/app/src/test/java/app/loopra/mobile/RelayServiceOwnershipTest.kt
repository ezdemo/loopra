package app.loopra.mobile

import org.junit.Assert.*
import org.junit.Test

class RelayServiceOwnershipTest {
  @Test
  fun oldStopCannotCloseTheReplacement() {
    val ownership = RelayServiceOwnership()
    ownership.claim("old")
    ownership.claim("new")
    assertFalse(ownership.close("old"))
    assertEquals("new", ownership.owner)
    assertTrue(ownership.close("new"))
    assertNull(ownership.owner)
    assertFalse(ownership.close("new"))
  }

  @Test
  fun cancellationBeforeStartPreventsLateRevival() {
    val ownership = RelayServiceOwnership()
    ownership.close("cancelled")
    try {
      ownership.claim("cancelled")
      fail("closed connection revived")
    } catch (_: IllegalStateException) {
      assertNull(ownership.owner)
    }
  }

  @Test
  fun failedStartRestoresThePriorOwnerAndShutdownRetiresIt() {
    val ownership = RelayServiceOwnership()
    ownership.claim("old")
    val previous = ownership.claim("new")
    ownership.rollback("new", previous)
    assertEquals("old", ownership.owner)
    ownership.clear()
    assertNull(ownership.owner)
    try {
      ownership.claim("old")
      fail("shutdown connection revived")
    } catch (_: IllegalStateException) {
      assertNull(ownership.owner)
    }
  }
}

package app.loopra.mobile

// Main-thread ownership prevents delayed stop/start callbacks from touching a replacement connection.
internal class RelayServiceOwnership {
  var owner: String? = null
    private set
  private val closed = ArrayDeque<String>()

  fun claim(id: String): String? {
    check(!closed.contains(id)) { "连接已关闭" }
    val previous = owner
    owner = id
    return previous
  }

  fun rollback(id: String, previous: String?) {
    if (owner == id) owner = previous?.takeUnless { closed.contains(it) }
  }

  fun close(id: String): Boolean {
    closed.addLast(id)
    if (closed.size > 128) closed.removeFirst()
    if (owner != id) return false
    owner = null
    return true
  }

  fun clear() {
    owner?.let { close(it) }
    owner = null
  }
}

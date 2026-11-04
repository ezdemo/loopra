package model

// Memory 是可独立更新的长期事实；Revision 用于阻止并发编辑互相覆盖。
type Memory struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	Kind      string `json:"kind"`
	Source    string `json:"source"`
	Revision  int64  `json:"revision"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

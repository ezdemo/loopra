package git

// Fail 是 Loopra Git API 约定的失败。
type Fail struct {
	Status  int
	Message string
}

func (f *Fail) Error() string   { return f.Message }
func (f *Fail) HTTPStatus() int { return f.Status }

func fail(status int, message string) error {
	return &Fail{Status: status, Message: message}
}

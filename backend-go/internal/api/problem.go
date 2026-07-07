package api

import (
	"encoding/json"
	"net/http"
)

// problemBody mirrors the TS sendProblem's exact JSON shape (RFC 7807
// problem+json), including the literal "about:blank" type value and
// the detail field being omitted entirely (not sent as null/empty)
// when no detail is given — src/api/problem.ts's
// `...(detail ? { detail } : {})` spread. omitempty on Detail
// reproduces that omission.
type problemBody struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// WriteProblem writes an RFC 7807 problem+json response — the Go
// analogue of src/api/problem.ts's sendProblem. Every route in this
// package that needs to return a client/server error uses this so the
// error shape is identical everywhere, matching the TS source's "one
// shared shape every M4 route uses."
func WriteProblem(w http.ResponseWriter, status int, title string, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(problemBody{
		Type:   "about:blank",
		Title:  title,
		Status: status,
		Detail: detail,
	})
}

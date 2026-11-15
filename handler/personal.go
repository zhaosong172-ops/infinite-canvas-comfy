package handler

import (
	"github.com/tigerowo/infinite-canvas/service"
	"net/http"
)

func PersonalSession(w http.ResponseWriter, r *http.Request) {
	session, err := service.PersonalSession(r.Header.Get("X-Personal-Secret"))
	if err != nil {
		FailWithStatus(w, http.StatusForbidden, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	OK(w, session)
}

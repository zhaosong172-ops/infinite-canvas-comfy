package service

import (
	"crypto/subtle"
	"errors"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// PersonalSession is enabled only by the desktop launcher with a per-process secret.
func PersonalSession(secret string) (model.AuthSession, error) {
	expected := config.Cfg.PersonalSecret
	if len(expected) < 32 || subtle.ConstantTimeCompare([]byte(secret), []byte(expected)) != 1 {
		return model.AuthSession{}, errors.New("个人模式未启用")
	}
	user, found, err := repository.GetUserByUsername("__personal_desktop__")
	if err != nil {
		return model.AuthSession{}, err
	}
	if !found {
		password, err := hashPassword(expected)
		if err != nil {
			return model.AuthSession{}, err
		}
		user, err = repository.SaveUser(model.User{ID: newID("user"), Username: "__personal_desktop__", DisplayName: "本机个人画布", Password: password, Role: model.UserRoleUser, Status: model.UserStatusActive, CreatedAt: now(), UpdatedAt: now()})
		if err != nil {
			return model.AuthSession{}, err
		}
	}
	return newSession(user)
}

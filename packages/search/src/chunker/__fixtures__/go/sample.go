package main

import "fmt"

const DefaultLimit = 10

// User is a registered person.
type User struct {
	ID   string
	Name string
}

// FetchUser looks up a user by id.
func FetchUser(id string) *User {
	return &User{ID: id, Name: "anon"}
}

func (u *User) Greet() string {
	return fmt.Sprintf("hi %s", u.Name)
}

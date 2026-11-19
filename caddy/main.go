// Caddy mit den Standardmodulen, aus dem Quellcode gebaut (siehe Dockerfile).
// Abhängigkeiten in go.mod/go.sum festgehalten; Dependabot aktualisiert sie.
package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	_ "github.com/caddyserver/caddy/v2/modules/standard"
)

func main() {
	caddycmd.Main()
}

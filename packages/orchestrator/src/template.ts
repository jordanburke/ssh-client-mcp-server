// The starter config written on first start at the default path. Every line is a comment, so it
// parses to zero hosts. Inside an example block, TOML lines start with "# " and prose with "## ", so
// removing the leading "# " turns a block into valid TOML (test/template.spec.ts checks each one).
export const FLEET_TEMPLATE = `# ssh-fleet-mcp-server config.
#
# Add at least one [[hosts]] entry, then restart the server. In Claude Code, use /mcp and
# reconnect. The fleet_setup tool shows what is configured and what is still missing.
#
# To use an example block, remove the leading "# " from each of its lines.
#
# Secrets never go in this file. Each host names one place its secret comes from:
#   password_env = env var holding a password    key = path to a private key
#   key_env      = env var holding a key (PEM)   agent = true (uses SSH_AUTH_SOCK)
#   ca           = a [[cas]] entry: the server signs a 10-minute certificate per connection
#
# Reference: https://github.com/jordanburke/ssh-client-mcp-server/tree/main/packages/orchestrator#fleet-config-schema

# --- example: host with a password from the environment ---
# [[hosts]]
# name = "mini"
# host = "mini.local"
# user = "me"
# password_env = "MINI_SSH_PASSWORD"
# --- end ---

# --- example: host with a key file ---
# [[hosts]]
# name = "build"
# host = "build.example.com"
# key = "~/.ssh/id_ed25519"
# --- end ---

# --- example: read-only policy for every host ---
## Only commands matching an allow pattern run. See the README's Policy section.
# [defaults.policy]
# mode = "readonly"
# allow = ['uptime', 'df -h']
# --- end ---

# --- example: certificate authority ---
## If key_file doesn't exist, the server creates it on first start. fleet_setup then shows
## the line to add to a root-owned authorized-keys file on each host. To keep the key off
## disk, use key_cmd (a command that prints it, e.g. a keychain read) or key_env instead.
# [[cas]]
# name = "home"
# key_file = "~/.local/state/ssh-fleet/ca-home"
#
# [[hosts]]
# name = "nas"
# host = "nas.local"
# user = "fleet"
# ca = "home"
# --- end ---
`

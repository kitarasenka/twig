#!/usr/bin/env bash
# Puts the Developer ID identity into a throwaway keychain for one macOS build.
#
#   P12_PASSWORD=… scripts/mac-signing-keychain.sh create <identity.p12> <file.keychain-db>
#     → prints the identity name to pass as CSC_NAME
#   scripts/mac-signing-keychain.sh delete <file.keychain-db>
#
# electron-builder can import CSC_LINK itself, but 26.0.12 unlocks its keychain
# with the .p12 password instead of the keychain's own one
# (`set-key-partition-list -k <p12 password>`), so that path fails. The build
# instead gets CSC_NAME + CSC_KEYCHAIN pointing at the keychain made here.
set -euo pipefail

action=${1:-}
case "$action" in
  create)
    p12=$2
    keychain=$3
    : "${P12_PASSWORD:?P12_PASSWORD is not set}"
    password=$(openssl rand -hex 24)
    security create-keychain -p "$password" "$keychain"
    security set-keychain-settings "$keychain" # no auto-lock mid-build
    security unlock-keychain -p "$password" "$keychain"
    security import "$p12" -k "$keychain" -P "$P12_PASSWORD" \
      -T /usr/bin/codesign -T /usr/bin/productbuild >/dev/null
    # Lets codesign use the key without a GUI prompt; -k is the keychain's password.
    security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
    # codesign only looks in keychains on the user search list.
    existing=()
    while IFS= read -r line; do
      line=${line#"${line%%[![:space:]]*}"}
      line=${line//\"/}
      [ -n "$line" ] && [ "$line" != "$keychain" ] && existing+=("$line")
    done < <(security list-keychains -d user)
    security list-keychains -d user -s "$keychain" "${existing[@]}"
    # Prints the CSC_NAME electron-builder wants: the identity without its
    # "Developer ID Application: " prefix (it refuses names that carry it).
    name=$(security find-identity -v -p codesigning "$keychain" \
      | sed -n 's/.*"Developer ID Application: \(.*\)"$/\1/p' | head -1)
    [ -n "$name" ] || { echo "no Developer ID Application identity in $p12" >&2; exit 1; }
    printf '%s\n' "$name"
    ;;
  delete)
    security delete-keychain "$2" 2>/dev/null || true
    ;;
  *)
    echo "usage: $0 create <identity.p12> <file.keychain-db> | delete <file.keychain-db>" >&2
    exit 2
    ;;
esac

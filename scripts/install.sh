#!/usr/bin/env bash
set -euo pipefail

usage() { printf '%s\n' 'Atelier Photo — installation utilisateur Mac / Linux' 'Usage : bash install.sh --repo PROPRIETAIRE/DEPOT [--destination /chemin/absolu]' 'Le script télécharge la dernière version publiée et vérifie SHA256SUMS.'; }
fail() { printf 'Erreur : %s\n' "$1" >&2; exit 1; }
repository=''
destination=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) [ "$#" -ge 2 ] || fail 'Valeur manquante pour --repo.'; repository="$2"; shift 2 ;;
    --destination) [ "$#" -ge 2 ] || fail 'Valeur manquante pour --destination.'; destination="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Option inconnue : $1" ;;
  esac
done
[[ "$repository" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'Indiquez un dépôt GitHub réel avec --repo PROPRIETAIRE/DEPOT.'
command -v curl >/dev/null 2>&1 || fail 'curl est nécessaire.'
system="$(uname -s)"
machine="$(uname -m)"
case "$system" in
  Darwin)
    platform='mac'; extension='zip'
    if [ "$machine" = 'arm64' ] || [ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" = '1' ]; then architecture='arm64';
    elif [ "$machine" = 'x86_64' ]; then architecture='x64'; else fail 'Architecture Mac non prise en charge.'; fi
    [ -n "$destination" ] || destination="$HOME/Applications"
    command -v ditto >/dev/null 2>&1 || fail 'L’outil macOS ditto est nécessaire.'
    command -v shasum >/dev/null 2>&1 || fail 'shasum est nécessaire.'
    target="$destination/Atelier Photo.app"
    ;;
  Linux)
    platform='linux'; extension='AppImage'
    [ "$machine" = 'x86_64' ] || fail 'Seule la version Linux x64 est préparée ; Linux ARM64 n’est pas validé.'
    architecture='x86_64'
    [ -n "$destination" ] || destination="$HOME/.local/opt/atelier-photo"
    command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum est nécessaire.'
    target="$destination/AtelierPhoto.AppImage"
    ;;
  *) fail 'Ce script prend en charge macOS et Linux. Utilisez install.ps1 sous Windows.' ;;
esac
[[ "$destination" = /* ]] || fail 'Le dossier de destination doit être un chemin absolu.'
[[ "$destination" != *$'\n'* && "$destination" != *$'\r'* ]] || fail 'Chemin de destination invalide.'
[ ! -e "$target" ] && [ ! -L "$target" ] || fail "Une installation existe déjà : $target. Déplacez-la avant de réinstaller."

task_tmp="$(mktemp -d "${TMPDIR:-/tmp}/atelier-photo-install.XXXXXXXX")"
trap 'rm -rf "$task_tmp"' EXIT
download() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 "$1" --output "$2"; }
printf '%s\n' 'Recherche de la dernière version publiée…'
release_url="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 60 --output /dev/null --write-out '%{url_effective}' "https://github.com/$repository/releases/latest")"
case "$release_url" in "https://github.com/"*"/releases/tag/"*) ;; *) fail 'Aucune version publiée n’a été trouvée.' ;; esac
tag="${release_url##*/}"
[[ "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'La dernière version doit avoir un tag stable vMAJEUR.MINEUR.CORRECTIF.'
version="${tag#v}"
asset="AtelierPhoto-$version-$platform-$architecture.$extension"
base="https://github.com/$repository/releases/download/$tag"
printf 'Téléchargement de %s…\n' "$asset"
download "$base/SHA256SUMS" "$task_tmp/SHA256SUMS"
expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$task_tmp/SHA256SUMS")"
[[ "$expected" =~ ^[A-Fa-f0-9]{64}$ ]] || fail 'L’empreinte SHA-256 exacte de cette archive est absente ou ambiguë.'
download "$base/$asset" "$task_tmp/$asset"
if [ "$platform" = 'mac' ]; then actual="$(shasum -a 256 "$task_tmp/$asset" | awk '{print $1}')";
else actual="$(sha256sum "$task_tmp/$asset" | awk '{print $1}')"; fi
[ "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" = "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ] || fail 'L’empreinte SHA-256 ne correspond pas. Installation annulée.'
printf '%s\n' 'Empreinte SHA-256 vérifiée.'
mkdir -p "$destination"
if [ "$platform" = 'mac' ]; then
  mkdir "$task_tmp/extracted"
  ditto -x -k "$task_tmp/$asset" "$task_tmp/extracted"
  [ -d "$task_tmp/extracted/Atelier Photo.app" ] || fail 'L’archive ne contient pas Atelier Photo.app.'
  mv "$task_tmp/extracted/Atelier Photo.app" "$target"
else
  chmod 755 "$task_tmp/$asset"
  mv "$task_tmp/$asset" "$target"
fi
printf '\nInstallation terminée : %s\n' "$target"
printf '%s\n' 'Lancez l’application depuis ce dossier. Aucune protection du système n’a été modifiée.'

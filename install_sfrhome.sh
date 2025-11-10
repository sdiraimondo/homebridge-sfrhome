#!/usr/bin/env bash
# install_sfrhome.sh
# Usage:
#   sudo ./install_sfrhome.sh --user you@example.com --password "MyP@ssw0rd" \
#       --script-path /homebridge/node_modules/homebridge-sfrhome/sfr_mysensors_sso.py \
#       --cron-user root
#
# Ce script crée /etc/sfrhome.env et ajoute une ligne cron (toutes les minutes)
# qui source ce fichier avant d'exécuter le script Python.
set -euo pipefail

# Defaults
ENV_FILE="/etc/sfrhome.env"
SCRIPT_PATH="/homebridge/node_modules/homebridge-sfrhome/sfr_mysensors_sso.py"
PYTHON_BIN="/usr/bin/python3"
CRON_USER="root"           # user whose crontab will be edited; if non-root run with that user
INSTALL_CRON="yes"

print_usage() {
  cat <<EOF
install_sfrhome.sh --user USER --password PASS [--script-path PATH] [--python PATH] [--cron-user USER] [--no-cron]

--user         : identifiant SFR (email)
--password     : mot de passe SFR (entourer par quotes si caractères spéciaux)
--script-path  : chemin du script python à lancer (défaut: ${SCRIPT_PATH})
--python       : chemin binaire python (défaut: ${PYTHON_BIN})
--cron-user    : user whose crontab will be modified (défaut: ${CRON_USER})
--no-cron      : n'ajoute pas la ligne cron
EOF
}

# Parse args (simple)
USER_ARG=""
PASS_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_ARG="$2"; shift 2;;
    --password) PASS_ARG="$2"; shift 2;;
    --script-path) SCRIPT_PATH="$2"; shift 2;;
    --python) PYTHON_BIN="$2"; shift 2;;
    --cron-user) CRON_USER="$2"; shift 2;;
    --no-cron) INSTALL_CRON="no"; shift 1;;
    -h|--help) print_usage; exit 0;;
    *) echo "Argument inconnu: $1"; print_usage; exit 1;;
  esac
done

if [[ -z "$USER_ARG" || -z "$PASS_ARG" ]]; then
  echo "[!] --user et --password sont obligatoires"
  print_usage
  exit 2
fi

if [[ ! -f "$PYTHON_BIN" ]]; then
  echo "[!] python introuvable : $PYTHON_BIN"
  exit 3
fi

# Ensure script path exists (not mandatory but recommended)
if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "[!] Attention : le script python n'a pas été trouvé au chemin : $SCRIPT_PATH"
  echo "    Le script sera quand même écrit dans la crontab, mais l'exécution pendra erreur si le chemin est faux."
fi

# Create or update env file
echo "[*] Écriture de ${ENV_FILE} (sauvegarde si déjà existant)"
if [[ -f "$ENV_FILE" ]]; then
  TIMESTAMP=$(date +%s)
  BACKUP="${ENV_FILE}.bak.${TIMESTAMP}"
  echo "  -> sauvegarde de l'ancien fichier dans ${BACKUP}"
  cp -p "$ENV_FILE" "$BACKUP"
fi

# Write file (secure)
cat > /tmp/sfrhome_env.tmp <<EOF
# /etc/sfrhome.env  - variables utilisées par le job sfr_mysensors_sso
# Generated on $(date -u)
export SFR_USER='${USER_ARG}'
export SFR_PASS='${PASS_ARG}'
EOF

# Move into place as root (requires sudo to run script)
mv /tmp/sfrhome_env.tmp "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
chown root:root "${ENV_FILE}" || true
echo "  -> ${ENV_FILE} créé (mode 600)."

# Add cron entry (if requested)
if [[ "${INSTALL_CRON}" == "yes" ]]; then
  echo "[*] Installation de la ligne cron (user: ${CRON_USER})"
  CRON_CMD="/bin/bash -lc 'source ${ENV_FILE} && ${PYTHON_BIN} ${SCRIPT_PATH} >> /tmp/sfrhome_cron.log 2>&1'"
  CRON_LINE="* * * * * ${CRON_CMD}"

  # install to the requested user's crontab
  if [[ "${CRON_USER}" == "root" ]]; then
    # use root crontab
    crontab -l 2>/dev/null | { cat; echo "${CRON_LINE}"; } | crontab -
  else
    # for non-root, use crontab -u (requires sudo)
    if sudo crontab -l -u "${CRON_USER}" >/dev/null 2>&1; then
      tmp=$(mktemp)
      sudo crontab -l -u "${CRON_USER}" > "${tmp}" || true
      if ! grep -F -x -q "${CRON_CMD}" "${tmp}"; then
        echo "${CRON_LINE}" >> "${tmp}"
        sudo crontab -u "${CRON_USER}" "${tmp}"
      else
        echo "  -> La ligne existe déjà pour ${CRON_USER}"
      fi
      rm -f "${tmp}"
    else
      echo "  -> Impossible de lire la crontab de ${CRON_USER} (privilèges manquants ?) ; essaye en sudo."
    fi
  fi

  # de-dup: remove duplicate identical cron lines (simple approach)
  if [[ "${CRON_USER}" == "root" ]]; then
    # compact crontab to unique lines
    tmpc=$(mktemp)
    crontab -l | awk '!x[$0]++' > "${tmpc}"
    crontab "${tmpc}"
    rm -f "${tmpc}"
  fi

  echo "  -> Ligne cron ajoutée (toutes les minutes). Log: /tmp/sfrhome_cron.log"
else
  echo "  -> Installation cron désactivée (--no-cron)"
fi

# Success message + verification hints
cat <<EOF

Installation terminée ✅

Vérifications utiles :
 - Contenu du fichier (masque le mot de passe si partagé) :
     sudo head -n 20 ${ENV_FILE}

 - Permissions :
     ls -l ${ENV_FILE}

 - Lancer manuellement le job (test rapide) :
     sudo /bin/bash -lc 'source ${ENV_FILE} && ${PYTHON_BIN} ${SCRIPT_PATH}'

 - Voir la crontab (si ajoutée) :
     sudo crontab -l

REMARQUES :
 - Le script écrit le mot de passe en clair dans ${ENV_FILE}. Si tu veux une gestion plus sûre,
   dis-le moi : je te proposerai une variante avec systemd (EnvironmentFile) ou gestion via un coffre.
 - Si tu es dans un conteneur Docker, vérifie que cron est effectivement en cours d'exécution dans ce conteneur.
   Dans beaucoup de conteneurs, cron n'est pas lancé par défaut — tu peux utiliser un process manager ou systemd
   (ou exécuter le script depuis le host).
EOF

exit 0

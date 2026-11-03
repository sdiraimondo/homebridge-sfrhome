# SFR Home pour Homebridge

Plugin Homebridge exposant les équipements **SFR HOME** à HomeKit via l'API SFR Home.

## Fonctionnement

- Récupération des états depuis `https://home.sfr.fr/mysensors` (XML)
- **Authentification SSO intégrée** directement dans le plugin Node.js (plus besoin de script externe)
- Réauthentification automatique en cas d'expiration des cookies
- Cookies persistés dans `/tmp/sfrhome_session_cookies.json`

## Fonctionnalités

- Récupération des périphériques SFR Home (contact, mouvement, fumée, température, humidité, ...) et des partenaires Hue, Legrand ou Netatmo
- Récupération du statut de l'alarme dans un device spécifique (Centrale)
- Exclusion de certains périphériques par nom ou par type dans le fichier `config.json`
- Pilotage des prises commandées ON/OFF
- Pilotage de l'alarme (Désactivé / Maison / Nuit / Absent)
- Support des volets/stores en tant que `WindowCovering`
- Support des lumières (catégorisé)

## À venir

- Amélioration du pilotage des lumières (dimming/couleur)
- Amélioration du pilotage des volets
- Flux caméra
- Création d'une version alternative sans abonnement ?

## Installation

```bash
# Cloner dans node_modules de Homebridge
git clone https://github.com/sdiraimondo/homebridge-sfrhome
cd ./homebridge-sfrhome

npm install
npm pack
sudo npm install -g ./homebridge-sfrhome-*.tgz

# ou en mode développement
sudo npm link
sudo npm link homebridge-sfrhome
```

## Configuration dans config.json

```json
{
    "platform": "SFRHomePlatform",
    "name": "SFR Home",
    "username": "votre.email@sfr.fr",
    "password": "votre_mot_de_passe",
    "cookiePath": "/tmp/sfrhome_session_cookies.json",
    "refreshSeconds": 30,
    "exclude": {
        "names": [
            "Météo"
        ],
        "models": [
            "METEO",
            "LED_BULB_DIMMER",
            "LED_BULB_HUE",
            "LED_BULB_COLOR"
        ]
    }
}
```

### Paramètres

| Paramètre | Requis | Défaut | Description |
|---|---|---|---|
| `platform` | Oui | - | Doit être `SFRHomePlatform` |
| `name` | Non | `SFR Home` | Nom de la plateforme |
| `username` | Oui* | - | Email/identifiant SFR |
| `password` | Oui* | - | Mot de passe SFR |
| `cookiePath` | Non | `/tmp/sfrhome_session_cookies.json` | Chemin de sauvegarde des cookies |
| `refreshSeconds` | Non | `60` | Fréquence de rafraîchissement des états (secondes) |
| `exclude.names` | Non | `[]` | Liste de noms de périphériques à exclure |
| `exclude.models` | Non | `[]` | Liste de types/modèles à exclure |

\* Requis pour la première authentification. Si des cookies valides existent déjà, ils seront utilisés en priorité.

## Notes

- Le plugin nécessite un abonnement SFR Home actif
- L'authentification se fait automatiquement au premier démarrage
- Les cookies sont renouvelés automatiquement si nécessaire

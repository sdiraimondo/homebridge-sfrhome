# SFR Home pour Homebridge

Plugin Homebridge exposant les équipements **SFR HOME** à HomeKit via l'API/Site SFR Home.
Ne fonctionne pour l'instant qu'avec un abonnement SFR Home.

## Fonctionnement
- Scrapping du site home.sfr.fr
- Authentification SSO intégrée directement dans le plugin (plus besoin de script Python externe ou de cron)
- Connexion : Cookies persistés avec réauthentification automatique en cas d'expiration

## Fonctionnalités
- Récupération des périphériques SFR Home (contact, mouvement, fumée, température, humidité, ...) et des partenaires Hue, Legrand ou Netamo
- Récupération du statut de l'alarme dans un device spécifique (Centrale)
- Exclusion de certains périphériques par nom ou par type (Météo, Hue…) dans le fichier config.json (permettant d'éviter les doublons si les périphériques sont déjà présents dans Homekit via un autre plugin)
- Pilotage des prises commandées On/Off

A venir :
- Pilotage des autres devices
- Flux Camera (peut-être possible en local directement)
- Création d'une version alternative sans abonnement ?

## Installation
```bash

# Clone dans le dossier node_modules de Homebridge et install des dépendances
git clone https://github.com/sdiraimondo/homebridge-sfrhome
cd ./homebridge-sfrhome

npm install
npm pack
sudo npm install -g ./homebridge-sfrhome-*.tgz

# ou
sudo npm link
sudo npm link homebridge-sfrhome

```

**Note:** L'authentification est maintenant intégrée au plugin. Plus besoin du script Python et du cron - il suffit de renseigner `username` et `password` dans la configuration. Les anciens scripts (`sfr_mysensors_sso.py`, `install_sfrhome.sh`) restent présents pour compatibilité mais ne sont plus nécessaires.

## Configuration du plugin dans Config.json
```
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

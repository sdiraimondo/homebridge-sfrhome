# SFR Home pour Homebridge

Plugin Homebridge exposant les équipements **SFR HOME** à HomeKit via scrapping du site SFR Home (script Python).
Ne fonctionne pour l'instant qu'avec un abonnement SFR Home.

## Fonctionnement
- Scrapping du site home.sfr.fr toutes les 2 minutes (via script python) et traitement en local
- Connexion : Cookies pour limiter le nombre de connexions, le login/password est utilisé pour la première connexion puis lors de l'expiration des cookies  

## Fonctionnalités
- Récupération des périphériques SFR Home (contact, mouvement, fumée, température, humidité, ...) et des partenaires Hue, Legrand ou Netamo
- Récupération du statut de l'alarme dans un device spécifique (Centrale)
- Exclusion de certains périphériques par nom ou par type (Météo, Hue…) dans le fichier config.json (permettant d'éviter les doublons si les périphériques sont déjà présents dans Homekit)
- Création d'une version alternative sans abonnement

A venir :
- Pilotage des devices (via Flask ?)
- Flux Camera (peut-être possible en local directement)

## Installation
```bash
# Install des dépendances (selon votre distribution)
pip install requests lxml beautifulsoup4

## ou
apt install python3 python3-requests python3-lxml python3-bs4

# Clone dans le dossier node_modules de Homebridge et install des dépendances
git clone https://github.com/sdiraimondo/homebridge-sfrhome
cd ./homebridge-sfrhome
sudo ./install_sfrhome.sh --user nom@domaine.com --password 'Password12345!' --cron-user homebridge

npm pack
sudo npm install -g ./homebridge-sfrhome-0.4.0.tgz

# ou
sudo npm link
sudo npm link homebridge-sfrhome

```

## Configuration du plugin dans Config.json
```
{
    "platform": "SFRHomePlatform",
    "name": "SFR Home",
    "devicesPath": "/tmp/devices.json",
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

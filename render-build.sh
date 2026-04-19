#!/usr/bin/env bash
set -e

# Installer LibreOffice pour la conversion PPTX → PDF
sudo apt-get install -y libreoffice --no-install-recommends

# Installer les dépendances Node
npm install

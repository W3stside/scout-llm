#!/usr/bin/env bash
# Hand the node_modules and playwright-cache named volumes to the node user.
#
# Why: both are Docker named volumes and are mounted root-owned. The obvious fix,
# `sudo chown node ...`, only worked in the base image because node had blanket
# NOPASSWD:ALL sudo. We removed that grant; this fixed, no-argument, root-owned script is
# the ONLY chown node may run as root (see sudoers in the Dockerfile), so it cannot be
# abused for arbitrary-path or symlink privilege escalation.
#
# Paths are hardcoded for exactly that reason — accepting them as arguments would
# reintroduce the escalation this script exists to prevent.
set -euo pipefail

chown node:node /workspaces/scout/node_modules
chown node:node /home/node/.cache/ms-playwright

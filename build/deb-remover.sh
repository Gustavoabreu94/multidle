#!/bin/bash

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

if [ "$1" = remove ] || [ "$1" = purge ]; then
    if [ -f /etc/apparmor.d/multidle ]; then
        apparmor_parser --remove /etc/apparmor.d/multidle 2>/dev/null || true
        rm -f /etc/apparmor.d/multidle
    fi
fi

#!/bin/bash
# usage: dl.sh <name> <extid>
curl -sSL -m 90 -o crx/$1.crx "https://clients2.google.com/service/update2/crx?response=redirect&os=linux&arch=x64&os_arch=x86_64&nacl_arch=x86-64&prod=chromiumcrx&prodchannel=&prodversion=140.0.0.0&lang=en-US&acceptformat=crx2,crx3&x=id%3D$2%26installsource%3Dondemand%26uc"
ls -la crx/$1.crx; file crx/$1.crx

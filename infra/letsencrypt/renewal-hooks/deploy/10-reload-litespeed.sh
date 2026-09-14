#!/bin/sh
# Recarrega o LiteSpeed depois que o certbot instala um certificado novo.
#
# Sem isto o certbot renova, o arquivo novo fica em /etc/letsencrypt/live/, e o
# LiteSpeed segue servindo da memoria o certificado que leu quando subiu — foi o
# que derrubou o app em 14/09/2026: certificado renovado em 13/08, processo no ar
# desde 07/08, e o antigo venceu em 12/09 ainda sendo servido.
#
# SIGUSR1 (reload) troca o certificado sem derrubar conexao em andamento.
set -e
LSWSCTRL=/usr/local/lsws/bin/lswsctrl
[ -x "$LSWSCTRL" ] || exit 0
"$LSWSCTRL" reload
logger -t certbot-deploy "LiteSpeed recarregado apos renovar ${RENEWED_DOMAINS:-certificado}"

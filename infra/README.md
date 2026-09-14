# infra

Arquivos que vivem **fora do projeto no servidor**, versionados aqui para não se
perderem numa reinstalação e para que a mudança fique registrada no histórico.

Nada aqui é lido em runtime: o conteúdo precisa ser copiado para o caminho de
destino no servidor.

## letsencrypt/renewal-hooks/deploy/10-reload-litespeed.sh

Destino: `/etc/letsencrypt/renewal-hooks/deploy/10-reload-litespeed.sh` (modo 755).

```sh
scp infra/letsencrypt/renewal-hooks/deploy/10-reload-litespeed.sh \
    lkl6:/etc/letsencrypt/renewal-hooks/deploy/
ssh lkl6 chmod +x /etc/letsencrypt/renewal-hooks/deploy/10-reload-litespeed.sh
```

O certbot renova o certificado sozinho, mas quem serve o HTTPS é o LiteSpeed, que
lê o certificado ao subir e o mantém em memória. Sem este hook a renovação não
chega ao processo: em 14/09/2026 o app saiu do ar com certificado vencido em
12/09 — embora houvesse um certificado válido em disco desde 13/08 — porque o
LiteSpeed estava no ar desde 07/08 e nunca recarregou.

Para conferir que o certbot enxerga o hook, sem esperar a renovação real:

```sh
ssh lkl6 'certbot renew --dry-run 2>&1 | grep -i "deploy hook"'
```

A simulação não executa o hook (a linha diz `Dry run: skipping deploy hook
command: ...`), mas o fato de citá-lo confirma que está registrado.

Para conferir qual certificado está realmente sendo servido — que é o que importa,
e não o que está em disco:

```sh
echo | openssl s_client -connect app.graficalkl.com.br:443 \
       -servername app.graficalkl.com.br 2>/dev/null | openssl x509 -noout -dates
```

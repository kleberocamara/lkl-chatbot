# nfe_sidecar/emitentes.py
import os

EMITENTES = {
    '19296723000108': {
        'razao_social': 'GRUPO DE GRAFICAS LKL LTDA',
        'cnpj': '19296723000108',
        'ie': '86591529',
        'csosn': '0102',
        'logradouro': 'RUA DOUTOR WALDIR DE SOUZA MEDEIROS',
        'numero': '315',
        'complemento': 'QUADRA 28 LOTE 38',
        'bairro': 'PARQUE DUQUE',
        'cep': '25085595',
        'municipio': 'Duque de Caxias',
        'c_mun': '3301702',
        'uf': 'RJ',
        'c_uf': '33',
        'cert_path': os.environ.get('SEFAZ_CERT_GRUPO', '/var/www/lkl-chatbot/certs/sefaz/grupo_lkl_19296723000108.pfx'),
        'cert_password': os.environ.get('SEFAZ_CERT_PASSWORD', '12345678'),
    },
    '44448899000185': {
        'razao_social': 'FACTOR COMUNICACAO VISUAL LTDA',
        'cnpj': '44448899000185',
        'ie': '12306440',
        'csosn': '0102',
        'logradouro': 'RUA DOUTOR WALDIR DE SOUZA MEDEIROS',
        'numero': '315',
        'complemento': 'QUADRA28 LOTE 38 ANEXO PARTE',
        'bairro': 'PARQUE DUQUE',
        'cep': '25085595',
        'municipio': 'Duque de Caxias',
        'c_mun': '3301702',
        'uf': 'RJ',
        'c_uf': '33',
        'cert_path': os.environ.get('SEFAZ_CERT_FACTOR', '/var/www/lkl-chatbot/certs/sefaz/factor_44448899000185.pfx'),
        'cert_password': os.environ.get('SEFAZ_CERT_PASSWORD', '12345678'),
    },
}

SEFAZ_URL = {
    '1': 'https://nfe.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
    '2': 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
}

NFE_AMBIENTE = os.environ.get('NFE_AMBIENTE', '2')

# nfe_sidecar/app.py
import os
import json
from flask import Flask, request, jsonify, send_file
from emitir import emitir_nfe
from danfe import gerar_danfe
from dacce import gerar_dacce
from eventos import cancelar_nfe, corrigir_nfe, inutilizar_nfe
from emitentes import EMITENTES

app = Flask(__name__)

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

@app.route('/emitir', methods=['POST'])
def emitir():
    try:
        dados = request.get_json(force=True)
        resultado = emitir_nfe(dados)
        return jsonify(resultado), (200 if resultado.get('status') == 'autorizada' else 422)
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

@app.route('/danfe', methods=['POST'])
def danfe():
    try:
        dados = request.get_json(force=True)
        pdf_path = gerar_danfe(dados['xml'], dados['output_path'])
        return send_file(pdf_path, mimetype='application/pdf')
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

@app.route('/dacce', methods=['POST'])
def dacce():
    try:
        dados = request.get_json(force=True)
        pdf_path = gerar_dacce(
            dados['xml_evento'],
            dados['output_path'],
            emitente=EMITENTES.get(dados.get('cnpj_emitente')),
            destinatario=dados.get('destinatario'),
            protocolo=dados.get('protocolo'),
        )
        return send_file(pdf_path, mimetype='application/pdf')
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

@app.route('/cancelar', methods=['POST'])
def cancelar():
    try:
        dados = request.get_json(force=True)
        resultado = cancelar_nfe(dados)
        if resultado.get('erro'):
            return jsonify(resultado), 400
        ok = resultado.get('status') == 'cancelada'
        return jsonify(resultado), (200 if ok else 422)
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

@app.route('/corrigir', methods=['POST'])
def corrigir():
    try:
        dados = request.get_json(force=True)
        resultado = corrigir_nfe(dados)
        if resultado.get('erro'):
            return jsonify(resultado), 400
        ok = resultado.get('status') == 'registrada'
        return jsonify(resultado), (200 if ok else 422)
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

@app.route('/inutilizar', methods=['POST'])
def inutilizar():
    try:
        dados = request.get_json(force=True)
        resultado = inutilizar_nfe(dados)
        if resultado.get('erro'):
            return jsonify(resultado), 400
        ok = resultado.get('status') == 'inutilizada'
        return jsonify(resultado), (200 if ok else 422)
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=3001, debug=False)

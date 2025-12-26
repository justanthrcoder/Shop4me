#!/usr/bin/env python
# database_format_changer.py
#
# Convierte un archivo maestro de productos en líneas tipo:
#   EAN,,,,0,DESCRIPCION
#
# Ejemplo:
# "D000000000000251541PANADERM AE HUMEC INTENSA 250ML EMU    02No Medicinal   1 HE7798051853364"
# -->
# "7798051853364,,,,0,PANADERM AE HUMEC INTENSA 250ML EMU"
#
# Características:
# - Pide al usuario un archivo .txt de entrada.
# - Procesa TODAS las líneas, sin romperse por formatos raros.
# - Para cada línea, busca un código de barras (HE / UC / HK / IC / Z / etc.)
#   y la descripción del producto.
# - Pregunta dónde guardar el archivo de salida (siempre .txt).
# - 1 línea de entrada -> 1 línea de salida, sin mezclar códigos con nombres.

import re
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox


# Prefijos de códigos que se consideran "códigos de barras" o equivalentes
# Orden de prioridad: si hay varios, se usa el primero en esta lista.
EAN_PREFIX_ORDER = [
    "HE",  # principal
    "UC",  # códigos tipo UC...
    "IC",
    "HK",
    "ST",
    "SR",
    "AD",
    "MA",
    "AL",
    "NI",
    "Z",
    "VC",
    "VF",
]


def extraer_codigo(linea: str) -> str:
    """
    Devuelve un código numérico (string de dígitos) extraído de la línea,
    siguiendo este criterio:

    1) Busca por orden de prioridad prefijos conocidos (HE, UC, HK, IC, Z, etc.).
       Devuelve los dígitos que siguen al prefijo.
    2) Si no encuentra ninguno de esos, busca cualquier bloque de dígitos largos
       (8 a 16 dígitos) en la línea.
    3) Si aún así no encuentra nada (por ejemplo la línea final "T19229"),
       devuelve "0" como placeholder.

    Siempre devuelve algo, nunca None.
    """
    # 1) Prefijos conocidos
    for prefijo in EAN_PREFIX_ORDER:
        m = re.search(prefijo + r"(\d{5,16})", linea)
        if m:
            return m.group(1)

    # 2) Cualquier bloque largo de dígitos (ej: por si algún otro formato raro)
    m2 = re.search(r"(\d{8,16})", linea)
    if m2:
        return m2.group(1)

    # 3) Último recurso: placeholder
    return "0"


def parsear_linea(linea: str):
    """
    Dada una línea de texto del archivo maestro, devuelve (descripcion, ean).

    - Si la línea empieza con 'D', se asume formato de producto:
        D + dígitos -> DESCRIPCION -> "01Medicinal"/"02No Medicinal"...
      La descripción se toma entre el código "D..." y el texto "01Medicinal"
      o "02No Medicinal", etc.
    - Si no empieza con 'D' (ej. línea "T19229"), la descripción es la línea entera.
    - El código se obtiene con extraer_codigo(linea).

    Nunca lanza error; siempre devuelve (descripcion, ean).
    """
    raw = linea.rstrip("\r\n")

    if not raw.strip():
        # Línea vacía: la podemos saltear en la salida
        return None

    if raw.startswith("D"):
        # Encabezado: D + dígitos
        m_header = re.match(r"^D(\d+)", raw)
        if m_header:
            desc_start = m_header.end()
        else:
            # Si por algún motivo no matchea, tomamos desde el inicio
            desc_start = 0

        # Marcador de tipo: 01Medicinal / 02Medicinal / 01No Medicinal / 02No Medicinal
        m_flag = re.search(r"\d{2}(?:Medicinal|No Medicinal)", raw)
        if m_flag:
            desc_end = m_flag.start()
        else:
            # Fallback raro: cortamos en el próximo bloque de espacios grandes
            m_spaces = re.search(r"\s{2,}", raw[desc_start:])
            if m_spaces:
                desc_end = desc_start + m_spaces.start()
            else:
                desc_end = len(raw)

        descripcion = raw[desc_start:desc_end].strip()
    else:
        # Líneas no estándar (ej. T19229)
        descripcion = raw.strip()

    ean = extraer_codigo(raw)
    return descripcion, ean


def main():
    # Inicializar Tkinter sin ventana visible
    root = tk.Tk()
    root.withdraw()

    # === 1) Elegir archivo de entrada (.txt) ===
    input_path = filedialog.askopenfilename(
        title="Seleccioná el archivo maestro (.txt)",
        filetypes=[("Archivos de texto", "*.txt"), ("Todos los archivos", "*.*")]
    )

    if not input_path:
        return  # usuario canceló

    input_path = Path(input_path)

    # === 2) Leer líneas del archivo ===
    try:
        # utf-8-sig elimina BOM si lo hubiera; errors="replace" evita que se rompa.
        with open(input_path, "r", encoding="utf-8-sig", errors="replace") as f:
            lineas = f.readlines()
    except Exception as e:
        messagebox.showerror(
            "Database Format Changer",
            f"No se pudo leer el archivo:\n{e}"
        )
        return

    # === 3) Procesar cada línea ===
    lineas_salida = []
    lineas_procesadas = 0
    lineas_saltadas = 0

    for linea in lineas:
        resultado = parsear_linea(linea)
        if resultado is None:
            # Línea vacía
            lineas_saltadas += 1
            continue

        descripcion, ean = resultado

        # Formato final: EAN,,,,0,DESCRIPCION
        nueva = f"{ean},,,,0,{descripcion}\n"
        lineas_salida.append(nueva)
        lineas_procesadas += 1

    # === 4) Elegir dónde guardar el archivo de salida (siempre .txt) ===
    default_name = input_path.stem + "_convertido.txt"
    output_path_str = filedialog.asksaveasfilename(
        title="Guardar archivo convertido (.txt)",
        defaultextension=".txt",
        initialfile=default_name,
        filetypes=[("Archivos de texto", "*.txt"), ("Todos los archivos", "*.*")]
    )

    if not output_path_str:
        return  # usuario canceló

    output_path = Path(output_path_str)

    # === 5) Escribir archivo de salida ===
    try:
        with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
            f.writelines(lineas_salida)
    except Exception as e:
        messagebox.showerror(
            "Database Format Changer",
            f"No se pudo escribir el archivo convertido:\n{e}"
        )
        return

    # === 6) Resumen (sin errores de parseo) ===
    msg = (
        f"Archivo convertido correctamente.\n\n"
        f"Líneas procesadas: {lineas_procesadas}\n"
        f"Líneas vacías saltadas: {lineas_saltadas}\n\n"
        f"Salida guardada en:\n{output_path}"
    )
    messagebox.showinfo("Database Format Changer", msg)


if __name__ == "__main__":
    main()

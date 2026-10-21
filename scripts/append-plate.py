"""Append a server-generated Orca 2.4.2 plate without changing existing G-code.

Uses only the Python standard library. Never extracts ZIP paths to the filesystem.
The caller owns the bounded, disposable workspace and subprocess timeout.
"""
import copy
import json
import math
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import PurePosixPath

CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'
PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06'
RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
MODEL = '3D/3dmodel.model'
SETTINGS = 'Metadata/model_settings.config'
INFO = 'Metadata/slice_info.config'
SEQUENCE = 'Metadata/filament_sequence.json'
XML_LIMIT = 8 * 1048576


def require(condition):
    if not condition:
        raise ValueError('Unsupported or invalid Orca print container')


def archive(path, limit):
    z = zipfile.ZipFile(path)
    entries = z.infolist()
    names = [e.filename for e in entries]
    require(len(names) <= 2000 and len(names) == len(set(names)))
    require(sum(e.file_size for e in entries) <= limit * 8)
    for e in entries:
        require(not e.flag_bits & 1 and not e.filename.startswith('/') and '\\' not in e.filename)
        require('..' not in PurePosixPath(e.filename).parts)
    return z


def read(z, name):
    require(z.getinfo(name).file_size <= XML_LIMIT)
    value = z.read(name)
    require(len(value) <= XML_LIMIT)
    return value


def xml(z, name):
    value = read(z, name)
    require(b'<!DOCTYPE' not in value.upper() and b'<!ENTITY' not in value.upper())
    return ET.fromstring(value)


def serialize(root):
    namespace = root.tag[1:].split('}')[0] if root.tag.startswith('{') else ''
    ET.register_namespace('', namespace or CORE)
    ET.register_namespace('p', PROD)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def metadata(element, key):
    return element.find(f"metadata[@key='{key}']")


def number(element, key):
    value = metadata(element, key)
    require(value is not None)
    return int(value.get('value'))


def move(item, dx, dy):
    matrix = [float(n) for n in item.get('transform', '1 0 0 0 1 0 0 0 1 0 0 0').split()]
    require(len(matrix) == 12 and all(math.isfinite(n) for n in matrix))
    matrix[9] += dx
    matrix[10] += dy
    item.set('transform', ' '.join(format(n, '.12g') for n in matrix))


def origin(plate, count):
    # Orca PartPlate: ceil(sqrt(count)) columns, bed dimension * 1.2 stride.
    cols = math.ceil(math.sqrt(count))
    return ((plate - 1) % cols * 216, -((plate - 1) // cols) * 216)


def append(parent_path, new_path, output_path, limit):
    with archive(parent_path, limit) as parent, archive(new_path, limit) as new:
        numbers = sorted(int(m[1]) for n in parent.namelist() if (m := re.fullmatch(r'Metadata/plate_([1-9]\d*)\.gcode', n)))
        require(numbers and numbers[-1] < 100)
        require([n for n in new.namelist() if re.fullmatch(r'Metadata/plate_[1-9]\d*\.gcode', n)] == ['Metadata/plate_1.gcode'])
        plate = numbers[-1] + 1
        model = xml(parent, MODEL)
        added_model = xml(new, MODEL)
        settings, added_settings = xml(parent, SETTINGS), xml(new, SETTINGS)
        info, added_info = xml(parent, INFO), xml(new, INFO)
        require(len(added_settings.findall('plate')) == 1 and len(added_info.findall('plate')) == 1)
        for z in (parent, new):
            project = json.loads(read(z, 'Metadata/project_settings.config'))
            require(project.get('printer_model') == 'Bambu Lab A1 mini' and project.get('nozzle_diameter') == ['0.4'])
        resources = model.find(f'{{{CORE}}}resources')
        build = model.find(f'{{{CORE}}}build')
        added_resources = added_model.find(f'{{{CORE}}}resources')
        added_build = added_model.find(f'{{{CORE}}}build')
        require(all(e is not None for e in (resources, build, added_resources, added_build)))
        max_id = max((int(e.get('id')) for e in resources), default=0)
        ids = {e.get('id'): str(max_id + i + 1) for i, e in enumerate(added_resources)}
        paths = {}
        for name in new.namelist():
            if name.startswith('3D/Objects/') and name.endswith('.model'):
                paths['/' + name] = f'/3D/Objects/plate_{plate}_{PurePosixPath(name).name}'
            elif name.startswith('Metadata/plate_1'):
                paths['/' + name] = '/' + name.replace('Metadata/plate_1', f'Metadata/plate_{plate}', 1)
        def rename(value):
            return paths.get(value, paths.get('/' + value, '/' + value).lstrip('/') if not value.startswith('/') else value)
        uuid_index = 0
        def references(element):
            nonlocal uuid_index
            for e in element.iter():
                uuid_index += 1
                for key, value in list(e.attrib.items()):
                    if key == f'{{{PROD}}}path':
                        require(value in paths)
                        e.set(key, paths[value])
                    elif key in ('objectid', 'object_id') and not e.get(f'{{{PROD}}}path'):
                        require(value in ids)
                        e.set(key, ids[value])
                    elif key == f'{{{PROD}}}UUID':
                        # Preserve Orca's UUID suffix while assigning a distinct backup ID.
                        e.set(key, f'{plate * 65536 + uuid_index:08x}' + value[8:])
                    elif key == 'value':
                        if e.get('key') == 'object_id':
                            require(value in ids)
                            e.set(key, ids[value])
                        else:
                            e.set(key, rename(value))
        # Moving the grid after a column count change affects only model transforms.
        instance_plate = {}
        for p in settings.findall('plate'):
            for inst in p.findall('model_instance'):
                instance_plate[(str(number(inst, 'object_id')), number(inst, 'instance_id'))] = number(p, 'plater_id')
        instances = {}
        for item in build:
            oid = item.get('objectid')
            index = instances.get(oid, 0)
            instances[oid] = index + 1
            p = instance_plate.get((oid, index))
            require(p is not None)
            before, after = origin(p, numbers[-1]), origin(p, plate)
            move(item, after[0] - before[0], after[1] - before[1])
        for obj in added_resources:
            obj = copy.deepcopy(obj)
            obj.set('id', ids[obj.get('id')])
            references(obj)
            resources.append(obj)
        for item in added_build:
            item = copy.deepcopy(item)
            references(item)
            move(item, *origin(plate, plate))
            build.append(item)
        for obj in added_settings.findall('object'):
            obj = copy.deepcopy(obj)
            obj.set('id', ids[obj.get('id')])
            references(obj)
            settings.append(obj)
        added_plate = copy.deepcopy(added_settings.find('plate'))
        references(added_plate)
        metadata(added_plate, 'plater_id').set('value', str(plate))
        settings.append(added_plate)
        sliced_plate = copy.deepcopy(added_info.find('plate'))
        metadata(sliced_plate, 'index').set('value', str(plate))
        info.append(sliced_plate)
        replacements = {MODEL: serialize(model), SETTINGS: serialize(settings), INFO: serialize(info)}
        for name in ['3D/_rels/3dmodel.model.rels', 'Metadata/_rels/model_settings.config.rels']:
            tree = xml(parent, name)
            for relation in xml(new, name):
                value = copy.deepcopy(relation)
                value.set('Target', rename(value.get('Target')))
                value.set('Id', f'pi-wedge-{plate}-{len(tree)}')
                tree.append(value)
            replacements[name] = serialize(tree)
        sequence = json.loads(read(parent, SEQUENCE))
        sequence[f'plate_{plate}'] = json.loads(read(new, SEQUENCE))['plate_1']
        replacements[SEQUENCE] = json.dumps(sequence).encode()
        total = 0
        with zipfile.ZipFile(output_path, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as output:
            def put(source, old, target):
                nonlocal total
                require(target not in output.namelist() and len(output.namelist()) < 2000)
                with source.open(old) as src, output.open(target, 'w') as dst:
                    while chunk := src.read(1048576):
                        total += len(chunk)
                        require(total <= limit * 8)
                        dst.write(chunk)
            for entry in parent.infolist():
                if entry.filename in replacements:
                    output.writestr(entry.filename, replacements[entry.filename])
                else:
                    put(parent, entry.filename, entry.filename)
            for old, target in paths.items():
                put(new, old.lstrip('/'), target.lstrip('/'))
        require(__import__('os').path.getsize(output_path) <= limit)
        print(json.dumps({'plate': plate}))


if __name__ == '__main__':
    try:
        append(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]))
    except Exception:
        # No paths, archive metadata or tool/config contents in public failures.
        print('Invalid or unsupported print container', file=sys.stderr)
        sys.exit(1)

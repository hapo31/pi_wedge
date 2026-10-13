"""Run with system Python + FreeCAD module path. No GUI or arbitrary user script."""
import json
import os
import sys

with open(os.environ['PI_WEDGE_CONVERSION_CONFIG'], encoding='utf-8') as source:
    config = json.load(source)
sys.path.insert(0, config['modulePath'])
import Part  # noqa: E402
import MeshPart  # noqa: E402

shape = Part.Shape()
shape.read(config['input'])
if shape.isNull() or not shape.isValid() or not shape.Solids:
    raise ValueError('STEP contains no valid closed solid')
bounds = shape.BoundBox
if any(v <= 0 or v > 180 for v in (bounds.XLength, bounds.YLength, bounds.ZLength)):
    raise ValueError('STEP dimensions exceed A1 mini build volume (mm)')
mesh = MeshPart.meshFromShape(
    Shape=shape,
    LinearDeflection=config['linearDeflection'],
    AngularDeflection=config['angularDeflection'],
    Relative=False,
)
if mesh.CountFacets == 0 or mesh.CountFacets > 1000000:
    raise ValueError('STEP mesh exceeds triangle limit or is empty')
mesh.write(config['output'])
print(json.dumps({'solids': len(shape.Solids), 'triangles': mesh.CountFacets,
                  'dimensionsMm': [bounds.XLength, bounds.YLength, bounds.ZLength]}))

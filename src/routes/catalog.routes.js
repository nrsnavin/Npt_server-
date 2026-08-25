import { Router } from 'express';
import Product from '../models/Product.js';
import Material from '../models/Material.js';
import Bom from '../models/Bom.js';
import Supplier from '../models/Supplier.js';
import Warehouse from '../models/Warehouse.js';
import crudController from '../controllers/crud.factory.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { bomSchema } from '../validators/schemas.js';

const products = crudController(Product, {
  searchFields: ['name', 'sku', 'color', 'moldNumber'],
  defaultSort: 'sku',
});
const materials = crudController(Material, {
  searchFields: ['name', 'code'],
  populate: [{ path: 'preferredSupplier', select: 'code name' }],
  defaultSort: 'code',
});
const boms = crudController(Bom, {
  populate: [
    { path: 'product', select: 'sku name' },
    { path: 'components.material', select: 'code name uom standardCost' },
  ],
  defaultSort: '-version',
});
const suppliers = crudController(Supplier, {
  searchFields: ['name', 'code', 'email', 'phone'],
  defaultSort: 'name',
});
const warehouses = crudController(Warehouse, { defaultSort: 'code' });

const router = Router();
const planner = authorize('production', 'inventory');

router.use(authenticate);

router.get('/products', products.list);
router.post('/products', planner, products.create);
router.get('/products/:id', products.getOne);
router.patch('/products/:id', planner, products.update);
router.delete('/products/:id', authorize('admin'), products.remove);

router.get('/materials', materials.list);
router.post('/materials', planner, materials.create);
router.get('/materials/:id', materials.getOne);
router.patch('/materials/:id', planner, materials.update);
router.delete('/materials/:id', authorize('admin'), materials.remove);

router.get('/boms', boms.list);
router.post('/boms', authorize('production'), validate(bomSchema), boms.create);
router.get('/boms/:id', boms.getOne);
router.patch('/boms/:id', authorize('production'), boms.update);
router.delete('/boms/:id', authorize('admin'), boms.remove);

router.get('/suppliers', suppliers.list);
router.post('/suppliers', planner, suppliers.create);
router.get('/suppliers/:id', suppliers.getOne);
router.patch('/suppliers/:id', planner, suppliers.update);
router.delete('/suppliers/:id', authorize('admin'), suppliers.remove);

router.get('/warehouses', warehouses.list);
router.post('/warehouses', authorize('inventory'), warehouses.create);
router.get('/warehouses/:id', warehouses.getOne);
router.patch('/warehouses/:id', authorize('inventory'), warehouses.update);
router.delete('/warehouses/:id', authorize('admin'), warehouses.remove);

export default router;

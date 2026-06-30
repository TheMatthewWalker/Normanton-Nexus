import sql from 'mssql';
import { sqlConfig } from '../config.js';
import express from 'express';

const router = express.Router();    

router.get('/test-otif-insert', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);

    const row = {
      customer: '0000301524',
      customerName: 'Kongsberg Automotive',
      plant: '3012',
      profitCentre: '0000002002',
      material: 'SBCF25-0B05/S',
      materialText: '1" Conductive Ultiflex® 316SS 1WB',
      delivery: '0082882298',
      deliveryDate: new Date('2026-04-24'),
      deliveryQty: 11,
      uom: 'M',
      targetDate: new Date('2026-04-24'),
      targetQty: 10,
      qtyClass: 'Q0-',
      dateClass: 'D0',
      onTime: true,
      valueStream: '2004-0'
    };

    await pool.request()
      .input('Customer', sql.VarChar(10), row.customer)
      .input('CustomerName', sql.VarChar(35), row.customerName)
      .input('Plant', sql.VarChar(4), row.plant)
      .input('ProfitCentre', sql.VarChar(10), row.profitCentre)
      .input('Material', sql.VarChar(18), row.material)
      .input('MaterialText', sql.VarChar(40), row.materialText)
      .input('Delivery', sql.VarChar(10), row.delivery)
      .input('DeliveryDate', sql.DateTime, row.deliveryDate)
      .input('DeliveryQty', sql.Decimal(15, 3), row.deliveryQty)
      .input('Uom', sql.VarChar(3), row.uom)
      .input('TargetDate', sql.DateTime, row.targetDate)
      .input('TargetQty', sql.Decimal(15, 3), row.targetQty)
      .input('QtyClass', sql.VarChar(4), row.qtyClass)
      .input('DateClass', sql.VarChar(4), row.dateClass)
      .input('OnTime', sql.Bit, row.onTime ? 1 : 0)
      .input('ValueStream', sql.VarChar(8), row.valueStream)
      .query(`
        INSERT INTO dbo.OtifSnapshot (
          Customer, CustomerName, Plant, ProfitCentre,
          Material, MaterialText, Delivery, DeliveryDate,
          DeliveryQty, Uom, TargetDate, TargetQty,
          QtyClass, DateClass, OnTime, ValueStream
        )
        VALUES (
          @Customer, @CustomerName, @Plant, @ProfitCentre,
          @Material, @MaterialText, @Delivery, @DeliveryDate,
          @DeliveryQty, @Uom, @TargetDate, @TargetQty,
          @QtyClass, @DateClass, @OnTime, @ValueStream
        )
      `);

    res.json({ success: true });

  } catch (err) {
    console.error('❌ TEST INSERT FAILED:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
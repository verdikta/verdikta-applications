// server/routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const { loadAdmins, isAdmin, addAdmin, removeAdmin } = require('../utils/adminsManager');
const { requireAdmin, requireAdminWithSignature } = require('../middleware/adminAuth');

/**
 * GET /api/admins/check/:address
 * Checks if an address is an admin (public endpoint)
 */
router.get('/check/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const adminStatus = await isAdmin(address);

    res.json({
      success: true,
      isAdmin: adminStatus.isAdmin,
      isBootstrap: adminStatus.isBootstrap
    });
  } catch (error) {
    console.error('Error checking admin status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check admin status'
    });
  }
});

/**
 * GET /api/admins
 * Returns list of all admins (requires admin address)
 */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const admins = await loadAdmins();

    // Format bootstrap admins
    const bootstrapAdmins = admins.bootstrap.map(addr => ({
      address: addr,
      isBootstrap: true,
      addedAt: null,
      addedBy: null
    }));

    // Combine and return
    res.json({
      success: true,
      admins: {
        bootstrap: bootstrapAdmins,
        regular: admins.regular,
        all: [...bootstrapAdmins, ...admins.regular]
      }
    });
  } catch (error) {
    console.error('Error fetching admins:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch admins',
      details: error.message
    });
  }
});

/**
 * POST /api/admins
 * Adds a new admin (requires admin with signature)
 */
router.post('/', requireAdminWithSignature, async (req, res) => {
  try {
    const { newAdminAddress } = req.body;
    const addedBy = req.verifiedAddress;

    if (!newAdminAddress) {
      return res.status(400).json({
        success: false,
        error: 'newAdminAddress is required'
      });
    }

    const newAdmin = await addAdmin(newAdminAddress, addedBy);

    res.status(201).json({
      success: true,
      message: 'Admin added successfully',
      admin: newAdmin
    });
  } catch (error) {
    console.error('Error adding admin:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to add admin'
    });
  }
});

/**
 * DELETE /api/admins/:address
 * Removes an admin (requires admin with signature)
 */
router.delete('/:address', requireAdminWithSignature, async (req, res) => {
  try {
    const { address } = req.params;

    await removeAdmin(address);

    res.json({
      success: true,
      message: 'Admin removed successfully'
    });
  } catch (error) {
    console.error('Error removing admin:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to remove admin'
    });
  }
});

module.exports = router;

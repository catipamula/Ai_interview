import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '../config/db';
import { assertEmailConfiguration, sendPasswordResetEmail } from '../services/email.service';

export const registerOrganizer = async (req: Request, res: Response) => {
  try {
    const { name, email, password, org_name } = req.body;
    
    const existing = await prisma.organizer.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const organizer = await prisma.organizer.create({
      data: { name, email, password_hash, org_name }
    });

    res.status(201).json({ message: 'Organizer created successfully', organizerId: organizer.id });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const loginOrganizer = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    
    const organizer = await prisma.organizer.findUnique({ where: { email } });
    if (!organizer) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, organizer.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const secret = process.env.JWT_SECRET || 'supersecret_for_local_dev';
    const token = jwt.sign({ id: organizer.id }, secret, { expiresIn: '1d' });

    res.json({ token, organizer: { id: organizer.id, name: organizer.name, org_name: organizer.org_name } });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const requestPasswordReset = async (req: Request, res: Response) => {
  const genericResponse = { message: 'If an account exists for that email, a password reset link has been sent.' };

  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return res.json(genericResponse);

    const organizer = await prisma.organizer.findUnique({ where: { email } });
    if (!organizer) return res.json(genericResponse);

    assertEmailConfiguration();
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await prisma.passwordResetToken.deleteMany({ where: { organizer_id: organizer.id } });
    await prisma.passwordResetToken.create({
      data: { organizer_id: organizer.id, token_hash: tokenHash, expires_at: expiresAt }
    });

    const frontendUrl = process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL;
    if (!frontendUrl) throw new Error('FRONTEND_URL is not configured');
    const resetLink = `${frontendUrl.replace(/\/$/, '')}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail(organizer.email, resetLink);

    return res.json(genericResponse);
  } catch (error) {
    console.error('Failed to request password reset:', error);
    return res.status(500).json({ error: 'Unable to send password reset email. Check the SMTP settings and server logs.' });
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  try {
    const token = typeof req.body.token === 'string' ? req.body.token : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!token || password.length < 8) {
      return res.status(400).json({ error: 'A valid token and a password of at least 8 characters are required.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const resetToken = await prisma.passwordResetToken.findUnique({ where: { token_hash: tokenHash } });
    if (!resetToken || resetToken.used_at || resetToken.expires_at <= new Date()) {
      return res.status(400).json({ error: 'This password reset link is invalid or expired.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.$transaction([
      prisma.organizer.update({ where: { id: resetToken.organizer_id }, data: { password_hash: passwordHash } }),
      prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { used_at: new Date() } })
    ]);

    return res.json({ message: 'Password reset successfully. You can now sign in.' });
  } catch (error) {
    console.error('Failed to reset password:', error);
    return res.status(500).json({ error: 'Unable to reset password.' });
  }
};
